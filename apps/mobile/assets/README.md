# assets/

Drop brand assets here (e.g. `drifthr-logo.svg`, app icon source) and then
declare them under `flutter: assets:` in `pubspec.yaml`, for example:

```yaml
flutter:
  uses-material-design: true
  assets:
    - assets/
```

The app currently renders a dependency-free wordmark (see
`lib/widgets/brand_logo.dart`) so no asset is required to build. Swap that widget
to load a bundled logo once you add one here.

> The real DriftHR logos live in `apps/ess/public/` (`drifthr-logo.svg`,
> `drifthr-logo-white.svg`, `drifthr-icon.svg`) — copy the one you want here.
