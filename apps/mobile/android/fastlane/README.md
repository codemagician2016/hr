fastlane documentation
----

# Installation

Make sure you have the latest version of the Xcode command line tools installed:

```sh
xcode-select --install
```

For _fastlane_ installation instructions, see [Installing _fastlane_](https://docs.fastlane.tools/#installing-fastlane)

# Available Actions

## Android

### android validate

```sh
[bundle exec] fastlane android validate
```

Validate the Play service-account key can reach the Play Store

### android play_internal

```sh
[bundle exec] fastlane android play_internal
```

Upload the built .aab to Play INTERNAL testing

Pre-req: flutter build appbundle --release --dart-define=API_URL=... --dart-define=PLATFORM_DOMAIN=... --build-number=$(date -u +%s)

----

This README.md is auto-generated and will be re-generated every time [_fastlane_](https://fastlane.tools) is run.

More information about _fastlane_ can be found on [fastlane.tools](https://fastlane.tools).

The documentation of _fastlane_ can be found on [docs.fastlane.tools](https://docs.fastlane.tools).
