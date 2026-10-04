# Dependency and service boundaries

The original project code and generic question materials in this repository are MIT licensed. Dependencies retain their own licenses.

The optional Sign in with ChatGPT DevKit is **not distributed in this Git repository**. `scripts/setup-siwc.mjs` retrieves only the local SDK source and license notices from OpenAI's repository at commit `f723814abdccec135b519c451fb6e1992ee5e933`, into the ignored `vendor/siwc/` directory. Its separate **SIGN-IN WITH CHATGPT DEVKIT NONCOMMERCIAL LICENSE v1.0** does not grant commercial-use rights. A free-to-download product is not automatically noncommercial under its definition. The MIT license here does not change those terms.

Read the [pinned license](https://github.com/openai/sign-in-with-chatgpt-devkit/blob/f723814abdccec135b519c451fb6e1992ee5e933/LICENSE) before installing. Keep its notices with any separately permitted redistribution. Account eligibility and OpenAI service terms are separate from source licensing; see the [Sign in with ChatGPT documentation](https://developers.openai.com/siwc/quickstart).

`jose` 6.1.0 and `proper-lockfile` 4.1.2 are pinned in the npm lockfile; their package license files remain in their installed packages. No dependency license is replaced by this repository's MIT license. Future commercial or hosted distribution requires a separately suitable provider adapter and terms review.
