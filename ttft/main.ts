/**
 * Cloudflare Worker that streams LLM API responses with timing measurements
 *
 * This worker takes the URL pathname as a prompt,
 * forwards it to the LLM API, and streams back the response with timing data
 * Can terminate after first token when ttft=true is specified
 */

export interface Env {
  LLM_ENDPOINT: string;
  LLM_TOKEN: string;
  LLM_MODEL: string;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Extract the pathname from the URL to use as the prompt
    const url = new URL(request.url);
    const prompt = decodeURIComponent(url.pathname.slice(1)); // Remove leading slash
    const includeMetrics = url.searchParams.get("metrics") === "true";
    const ttftOnly = url.searchParams.get("ttft") === "true";

    if (!prompt) {
      return new Response("No prompt provided in the pathname", {
        status: 400,
      });
    }

    try {
      // Start timing
      const startTime = Date.now();
      let ttft = 0;
      let ttftReported = false;

      // Prepare the API request to the LLM endpoint
      const apiRequest = {
        messages: [{ role: "user", content: prompt }],
        stream: true,
        model: env.LLM_MODEL,
      };
      // Make the API request
      const apiResponse = await fetch(env.LLM_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.LLM_TOKEN}`,
        },
        body: JSON.stringify(apiRequest),
      });

      if (!apiResponse.ok) {
        const errorText = await apiResponse.text();
        return new Response(
          `LLM API Error: ${apiResponse.status} - ${errorText}`,
          { status: apiResponse.status },
        );
      }

      // Verify we have a readable stream from the API
      if (!apiResponse.body) {
        return new Response("Failed to get response stream from LLM API", {
          status: 500,
        });
      }

      // Create a TransformStream to process the SSE data from the LLM API
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();

      // Process the stream in the background
      const textDecoder = new TextDecoder();
      const textEncoder = new TextEncoder();

      // Handle the streaming response in the background
      ctx.waitUntil(
        (async () => {
          const reader = apiResponse.body!.getReader();
          let buffer = "";
          let firstTokenReceived = false;

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += textDecoder.decode(value, { stream: true });

              // Process buffer line by line (SSE format)
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                if (line.startsWith("data:")) {
                  const data = line.slice(5).trim();

                  // Check for the end of the stream
                  if (data === "[DONE]") continue;

                  try {
                    const parsed = JSON.parse(data);
                    const content = parsed.choices?.[0]?.delta?.content || "";

                    if (content) {
                      // If this is the first token, record TTFT
                      if (!firstTokenReceived) {
                        ttft = Date.now() - startTime;
                        firstTokenReceived = true;

                        // If ttftOnly mode is active, return the TTFT and terminate
                        if (ttftOnly) {
                          await writer.write(
                            textEncoder.encode(`TTFT: ${ttft}ms`),
                          );
                          await writer.close();
                          // Cancel ongoing fetch by calling cancel on the reader
                          reader.cancel("TTFT-only mode");
                          return; // Exit the processing loop
                        }

                        // If metrics are requested, prepend TTFT to the response
                        if (includeMetrics && !ttftReported) {
                          await writer.write(
                            textEncoder.encode(`[TTFT: ${ttft}ms]\n\n`),
                          );
                          ttftReported = true;
                        }
                      }

                      await writer.write(textEncoder.encode(content));
                    }
                  } catch (error) {
                    console.error("Error parsing JSON from stream:", error);
                  }
                }
              }
            }

            // Process any remaining data in the buffer
            if (buffer) {
              const lines = buffer.split("\n");
              for (const line of lines) {
                if (
                  line.startsWith("data:") &&
                  line.slice(5).trim() !== "[DONE]"
                ) {
                  try {
                    const data = line.slice(5).trim();
                    const parsed = JSON.parse(data);
                    const content = parsed.choices?.[0]?.delta?.content || "";

                    if (content) {
                      // If this is the first token, record TTFT
                      if (!firstTokenReceived) {
                        ttft = Date.now() - startTime;
                        firstTokenReceived = true;

                        // If ttftOnly mode is active, return the TTFT and terminate
                        if (ttftOnly) {
                          await writer.write(
                            textEncoder.encode(`TTFT: ${ttft}ms`),
                          );
                          await writer.close();
                          return; // Exit the processing loop
                        }

                        // If metrics are requested, prepend TTFT to the response
                        if (includeMetrics && !ttftReported) {
                          await writer.write(
                            textEncoder.encode(`[TTFT: ${ttft}ms]\n\n`),
                          );
                          ttftReported = true;
                        }
                      }

                      await writer.write(textEncoder.encode(content));
                    }
                  } catch (error) {
                    // Ignore JSON parsing errors in the final buffer
                  }
                }
              }
            }

            // Add total time at the end if metrics are requested
            if (includeMetrics) {
              const totalTime = Date.now() - startTime;
              await writer.write(
                textEncoder.encode(`\n\n[Total Response Time: ${totalTime}ms]`),
              );
            }
          } catch (error) {
            console.error("Error processing stream:", error);
            if (includeMetrics) {
              await writer.write(
                textEncoder.encode(`\n\n[Error: ${error.message}]`),
              );
            }
          } finally {
            await writer.close();
          }
        })(),
      );

      // Return the streaming response
      return new Response(readable, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Transfer-Encoding": "chunked",
        },
      });
    } catch (error) {
      return new Response(`Error: ${error.message}`, { status: 500 });
    }
  },
};
