# wiki-plugin-unfurl

A link-preview **Outpost** for federated wiki. `GET /system/unfurl.json?url=…` returns a
normalised static card. This is the server half extracted from `wiki-plugin-hitchhiker`
(0.3.x) so that the two heavy extractor libraries live on one host and every other farm
carries none. See `pages/about-unfurl-plugin` for the full account, and the Outpost page
on plugin.fedwiki.club for how farms discover it.

Install on the Outpost host only:

    npm install --prefix "$(npm root -g)/wiki" wiki-plugin-unfurl

ESM server (`import()` on wiki-server ≥ Node 22). Imports are lazy — start-up cost < 1 MB.
Not for a public IP without an API key in front of it.
