// Boot splash. The session is already hydrated by main() before runApp, so this
// is just a branded holding screen shown while AuthController.bootstrap()
// validates the session. The router redirects away as soon as auth resolves.

import 'package:flutter/material.dart';

import '../../theme/app_theme.dart';
import '../../widgets/brand_logo.dart';

class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      backgroundColor: BrandColors.bg,
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            BrandLogo(size: 56),
            SizedBox(height: 28),
            SizedBox(
              width: 22,
              height: 22,
              child: CircularProgressIndicator(strokeWidth: 2.4),
            ),
          ],
        ),
      ),
    );
  }
}
