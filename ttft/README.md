A cloudflare worker in typescript that takes the pathname as the query url decoded, then performs a prompt using the standard /chat/completion api, using these environment variables:

- env.LLM_ENDPOINT
- env.LLM_TOKEN

It uses stream, and writes the output to the Response as tokens come in.
