// DriftHR wordmark — a lightweight, dependency-free brand lockup so the app
// looks finished even before the real SVG/PNG logo asset is bundled. A teal
// rounded badge with the "d" glyph + the DriftHR wordmark and tagline.

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

class BrandLogo extends StatelessWidget {
  const BrandLogo({super.key, this.showTagline = true, this.size = 44});

  final bool showTagline;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: size,
              height: size,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [BrandColors.teal, BrandColors.tealDark],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(size * 0.28),
              ),
              child: Text(
                'd',
                style: TextStyle(
                  color: Colors.white,
                  fontSize: size * 0.56,
                  fontWeight: FontWeight.w800,
                  height: 1,
                ),
              ),
            ),
            const SizedBox(width: 10),
            const Text(
              'DriftHR',
              style: TextStyle(
                fontSize: 24,
                fontWeight: FontWeight.w800,
                color: BrandColors.ink,
                letterSpacing: -0.5,
              ),
            ),
          ],
        ),
        if (showTagline) ...[
          const SizedBox(height: 8),
          const Text(
            'Effortless HR & payroll.',
            style: TextStyle(fontSize: 13, color: BrandColors.muted),
          ),
        ],
      ],
    );
  }
}
