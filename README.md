Goal: Test ttft and time to response in different locations around the world.

Solution:

1. `wilmake_ttft` (https://ttft.wilmake.com/hello-world?ttft=true&metrics=true) tests TTFT for the provided LLM Endpoint.
2. `wilmake_probe` (https://probe.wilmake.com) uses the Pingdom API to access this endpoint from several locations around the world.

Results:

I tested `llama-3.3-70b` on https://api.cerebras.ai/v1/chat/completions, and found that it's significantly faster in North America than it is in Europe, averaging 344ms versus 748ms respectively.

```json
{
  "target": {
    "host": "ttft.wilmake.com",
    "path": "/hello-world?ttft=true&metrics=true",
    "url": "https://ttft.wilmake.com/hello-world?ttft=true&metrics=true"
  },
  "timestamp": "2025-05-08T11:02:48.121Z",
  "stats": {
    "count": 9,
    "successful": 9,
    "failed": 0,
    "average": 554.2222222222222,
    "median": 474,
    "min": 244,
    "max": 885,
    "p90": 885,
    "p95": 885,
    "p99": 885,
    "by_region": {
      "Europe": {
        "count": 4,
        "successful": 4,
        "failed": 0,
        "average": 748,
        "median": 829,
        "min": 474,
        "max": 885
      },
      "North America": {
        "count": 4,
        "successful": 4,
        "failed": 0,
        "average": 344.5,
        "median": 380,
        "min": 244,
        "max": 390
      },
      "Unknown": {
        "count": 1,
        "successful": 1,
        "failed": 0,
        "average": 618,
        "median": 618,
        "min": 618,
        "max": 618
      }
    }
  }
}
```
