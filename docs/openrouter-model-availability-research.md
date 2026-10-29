# OpenRouter model availability investigation

Investigated 2026-10-29. Documentation findings only; authenticated observations are recorded separately below when available. No product implementation is included.

## Supported discovery API

OpenRouter documents `GET https://openrouter.ai/api/v1/models/user` with bearer-token authentication. It filters models by user provider preferences, privacy settings, and guardrails. It returns text-output models by default; `output_modalities=all` requests all modalities. Omit both `offset` and `limit` to request the complete list. Regional hostnames further restrict results to in-region models. [Filtered models API](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails)

For a given configured API key, this is the primary read-only discovery mechanism. Compare its model IDs with the general catalog using equivalent modality/region scope to identify catalog models unavailable under that key's effective settings. This comparison is a recommendation derived from the documented filtering contract, rather than a documented per-model reason API. [General models API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)

## Why an organization can remove every route

Guardrails can restrict models and providers and require zero data retention. Account settings remain enforced; member and API-key guardrails layer on top. Model/provider allowlists intersect, while ZDR requirements combine restrictively. Consequently an otherwise public model can have no eligible provider for a particular key. Management of guardrails requires organization administrator privileges; the discovery approach does not require changing policy. [Guardrail overview](https://openrouter.ai/docs/guides/features/guardrails/overview)

## Limits and error handling

- The filtered API returns model records, not an exclusion reason for each omitted model. An omission supports “unavailable under this key's effective settings,” not automatically “company explicitly blocked this model.” The cause can include provider/privacy settings and regional filtering. [Filtered models API](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails)
- The OpenAPI contract names `/models/{author}/{slug}/endpoints` as the endpoint catalog and does not document user-policy filtering for it. Do not infer policy eligibility merely from the existence of public providers. [OpenAPI schema](https://openrouter.ai/openapi.json)
- Discovery is not a promise that an arbitrary inference request will succeed: request content, budgets, credentials, routing requirements, rate limits, or provider failures can still reject it. Guardrail content blocks can return `403` before forwarding to a provider; the API separately describes budget and routing failures. Preserve and display request errors rather than permanently classifying every failure as a disabled model. [Errors and debugging](https://openrouter.ai/docs/api_reference/errors-and-debugging)
- Use the exact key configured for generation: member-level browser eligibility alone cannot prove a separately restricted API key has the same availability. This follows from the documented member/key guardrail layering. [Guardrail overview](https://openrouter.ai/docs/guides/features/guardrails/overview)

## Live verification

On 2026-10-29, Edge showed the RingCentral account on the supplied model page, with every listed provider marked “Not routable.” [Observed model page](https://openrouter.ai/deepseek/deepseek-v4.1-flash-1017)

Using the desktop Weft database's configured API key, read-only GET requests to the public `/models` and authenticated `/models/user` endpoints both returned HTTP 200. The key stayed in process memory and curl's stdin; it was not printed, written into this note, or passed in command-line arguments. Both requests used the default host and omitted pagination and modality parameters.

- Public catalog: 456 distinct model IDs; key-filtered catalog: 244.
- 213 public IDs were absent from the key-filtered result; one ID was present only in the filtered result. These are independent catalog snapshots, not a strict partition or a count of explicit company blocks.
- `deepseek/deepseek-v4.1-flash-1017`: present publicly, absent for the configured key. The documented discovery mechanism detects this specific restriction.
- The desktop's configured `z-ai/glm-5.3-flash`: present in both results. No inference success is claimed.

Current Weft discovery in `src/model-settings.ts` uses the unauthenticated public `/models` endpoint and keeps the first 100 text-output records. It therefore does not currently apply the key-specific discovery filter. The repository development database had no saved key; the live check used the separate desktop database opened read-only. No database or application settings were changed.

Python's HTTPS client initially failed local certificate validation. The successful checks used the system curl client with normal certificate verification; certificate verification was not disabled. No generation requests or policy mutations were made.

### Subsequent disabled-model request test

After the user explicitly requested testing submission with a disabled model, a minimal POST to `/api/v1/responses` used the desktop's saved key, model `deepseek/deepseek-v4.1-flash-1017`, input `Reply OK.`, `max_output_tokens: 1`, and `stream: true`. OpenRouter returned HTTP 404 with JSON error code 404, not an SSE success stream. The message reported zero eligible endpoints and explicitly said “Model blocked by guardrail: 40 endpoints excluded.” Its metadata included `failed_routing_step: "Filter by Guardrails"` and structured `ineligibility_reasons`, including `model-ignored-by-guardrail`. Other overlapping exclusions concerned provider guardrails, ZDR, and training policies. No successful generation occurred. No application settings or saved models were changed.

This verifies the upstream response, not the running desktop's complete submission/error UI. Current transport records failed response bodies but raises the generic `modelRequestFailed`; the planned regression must verify useful Agent-facing messaging, saved Model Call details, continued application responsiveness, and recovery with an available model.

## Specification

The agreed behavior and implementation acceptance criteria are published in [#203](https://github.com/tylerlong/weft/issues/203). It is the authoritative specification; this note preserves the investigation and upstream observations. Product implementation and full application failure/recovery validation have not started.

The specification separates preserved configured models from current-key availability, refreshes discovery on startup/Settings opening/key changes/Retry, restricts new choices and editing when discovery is unknown, and preserves ordinary request-time failure handling for existing selections. Key changes never clear or replace saved models, defaults, or Chat model/reasoning selections. Documentation updates to onboarding and the user guide are part of implementation, not claims of current behavior.
