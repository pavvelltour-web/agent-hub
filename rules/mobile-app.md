## Rules for a mobile app
- **Find the stack first** (Expo / React Native, Flutter, Swift, Kotlin) from the repository and follow its conventions. Do not mix stacks.
- **Design.** Use `product-ui-workbench`, `design-quality-loop` and `mobile-design` when installed. Base each flow (onboarding, sign-in, payment, empty states) on real app references before inventing one.
- **Touch and layout.** Touch targets at least 44 pt, respect safe areas and the keyboard, support dynamic text size, check small and large phones.
- **Network and state.** Assume slow or no network: show cached data, queue writes, make every request cancellable and retry-safe. Never block the UI thread.
- **Secrets.** Anything inside the app bundle can be extracted. Keep real keys on a server; the app holds only public identifiers.
- **Permissions and privacy.** Ask for a permission at the moment it is needed, with one sentence of why. Collect the minimum data; analytics only after consent.
- **Store rules.** Account deletion in the app, privacy labels, no private APIs. Raise anything that risks review rejection before building it.
- **Release.** Bump the version and build number, keep a changelog, test the release build, not only debug.
- **Done also means:** the flow ran on a simulator or device, with screenshots for each changed screen.
