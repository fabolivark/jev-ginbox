# Docs

Current-state docs for jev-inbox.

- `gmail-dom.md`: the Gmail selectors the content script relies on, and what to check first when Gmail changes its markup.
- `store-listing.md`: draft Chrome Web Store text, permission justifications, data use disclosure answers, and the Images section listing each store asset.
- `manage/`: screenshots of the manage page from `npm run e2e` at 1440, 768, 390 and 320 in light and dark, plus a pick split into numbered searches and the page on a cache written before entries kept a sender (`manage-upgrade-*`). Refresh them by copying `e2e-results/manage-*.png`.
- `select/`: the bar with two Money rows selected in Gmail's checkboxes, light and dark, at 1440 and 390 wide, from `npm run e2e`.
- `store/`: Chrome Web Store screenshots and promo tiles, built from `dev/store/` by `npm run store-images`.

`dev/store/` holds the HTML sources for the Chrome Web Store images: `scene.html` renders the five Gmail-window screenshots, `promo.html` renders the two promo tiles, and `stub.ts` is the storage stub that drives the real popup markup for those captures. Intermediates land in `dev/store/raw/`, which stays gitignored.
