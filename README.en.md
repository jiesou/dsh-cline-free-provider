# dsh-cline-free-provider

Cline Free provider for dsh.

[简体中文](README.md)

<img height="650" alt="截图 2026-08-17 10-39-41" src="https://github.com/user-attachments/assets/849c8ca8-2f97-4603-898a-37598a2dede5" />

Cline provides a range of free models available through OpenRouter, as well as DeepSeek V4 Flash, GLM 5.3 Flash and Muse Spark 1.3. This plugin dynamically filters Cline's model catalog for free models and makes them available in DSH.

If you use a Cline Pass subscription, follow Cline's official documentation to configure the official API and API key directly. This plugin is not needed.

Get an API key from <https://app.cline.bot/dashboard/account?tab=api-keys>.

## Install

From npm (prebuilt, recommended):

```sh
dsh plugin --profile web add @jiesou/dsh-cline-free-provider
```

Or from GitHub:

```sh
dsh plugin --profile web add github:jiesou/dsh-cline-free-provider
```

## After install

Cline's API key is stored through DSH's credentials service under `CLINE_API_KEY` (the Web Models page can write it). No model configuration is needed—the plugin automatically syncs and filters the free catalog on startup. Pick the Cline provider and a model on the Web Models page to start chatting.

### Configuration

All optional, defaults work out of the box:

```yaml
- id: cline-free-provider
  name: '@jiesou/dsh-cline-free-provider'
  config:
    apiKeyEnv: CLINE_API_KEY
    baseURL: https://api.cline.bot/api/v1
    defaultMaxTokens: 32768
    defaultContextWindow: 262144
    maxRequestImageBytes: 2097152
    requestImageMaxBytes: 1048576
```

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKeyEnv` | `string` | `"CLINE_API_KEY"` | Env var (or credential ref) holding the API key |
| `baseURL` | `string` | `"https://api.cline.bot/api/v1"` | Cline gateway base URL |
| `defaultMaxTokens` | `number` | `32768` | Output cap fallback for models without an exact value |
| `defaultContextWindow` | `number` | `262144` | Context capacity fallback for models without an exact value |
| `maxRequestImageBytes` | `number` | `2097152` (2 MiB) | Inline base64 image budget for one request |
| `requestImageMaxBytes` | `number` | `1048576` (1 MiB) | Per-image budget after re-encoding |

## Images

This wire is stateless: every request re-sends the history, so every image left in context is uploaded again on every turn.

- Each image is normalized first: a 2048×2048 pixel budget, then re-encoded to fit `requestImageMaxBytes` (1 MiB by default).
- When the inline base64 images of one request exceed `maxRequestImageBytes` (2 MiB by default), no request is sent; the adapter throws `IMAGE_OFFLOAD_REQUIRED` naming how many occurrences must be offloaded. DSH records the **oldest** ones in an `image/offload` event and retries; from then on their bytes are replaced by placeholder text that still names the image identity and a readable path.
- Already-offloaded images are never read, re-encoded, or uploaded again.

Both values count base64 characters (about 4/3 of the raw bytes). The default pair holds one full-size image plus one half-size image; lower both to save more bandwidth, but keep `maxRequestImageBytes` above one image's base64 length (a 1 MiB image is ~1.4 MB), or not even one image fits.

## Model catalog & reasoning effort

The plugin fetches the free catalog once at startup and never re-scans — the upstream rotates slowly, and a static catalog is plenty. If the upstream is unreachable at mount the plugin still comes up (with an empty catalog); one network blip never takes the plugin, or the model surface, down.

Reasoning effort: a model exposes exactly the levels the upstream feeds credit it with. **Default** means "do not send `reasoning_effort`" — the upstream picks its own depth. **Off** is a real switch: it sends the upstream's literal close value (`none`, `off`, …). Models the upstream marks mandatory drop the `Off` entry — there is no way to disable thinking, and the plugin doesn't fabricate one.

Error reporting: upstream refusals (ended free promotions, region blocks, …) preserve the real reason in the terminal error event — the harness would otherwise mask them under "API key is invalid". Genuine auth failures still surface as AUTH.

## License

[MIT](LICENSE)
