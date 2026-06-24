// DriftHR brand palette + Material 3 theme for the mobile ESS app.
//
// Brand: teal #16B6A6 (primary) / ink #16243B (text + dark surfaces). Premium,
// light, rounded cards — mirrors apps/hr-mobile/src/theme.js and the ESS web
// CSS variables (--theme-primary / --theme-text / --theme-muted / …).

import 'package:flutter/material.dart';

class BrandColors {
  BrandColors._();

  // Brand
  static const Color teal = Color(0xFF16B6A6);
  static const Color tealDark = Color(0xFF0E9488);
  static const Color tealSoft = Color(0xFFE6F7F4);
  static const Color ink = Color(0xFF16243B);
  static const Color inkSoft = Color(0xFF243651);

  // Semantic surfaces
  static const Color onPrimary = Color(0xFFFFFFFF);
  static const Color text = Color(0xFF16243B);
  static const Color muted = Color(0xFF64748B);
  static const Color border = Color(0xFFE2E8F0);
  static const Color bg = Color(0xFFF6F8FA);
  static const Color card = Color(0xFFFFFFFF);

  // States
  static const Color success = Color(0xFF16A34A);
  static const Color successSoft = Color(0xFFDCFCE7);
  static const Color warning = Color(0xFFD97706);
  static const Color warningSoft = Color(0xFFFEF3C7);
  static const Color danger = Color(0xFFDC2626);
  static const Color dangerSoft = Color(0xFFFEE2E2);

  static const Color violet = Color(0xFF6D28D9);
  static const Color violetSoft = Color(0xFFF5F3FF);
  static const Color info = Color(0xFF1D4ED8);
  static const Color infoSoft = Color(0xFFEFF6FF);
}

class BrandRadii {
  BrandRadii._();
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 24;
  static const double pill = 999;
}

class AppTheme {
  AppTheme._();

  static ThemeData get light {
    final colorScheme = ColorScheme.fromSeed(
      seedColor: BrandColors.teal,
      brightness: Brightness.light,
    ).copyWith(
      primary: BrandColors.teal,
      onPrimary: BrandColors.onPrimary,
      surface: BrandColors.card,
      onSurface: BrandColors.text,
      error: BrandColors.danger,
    );

    final base = ThemeData(
      useMaterial3: true,
      colorScheme: colorScheme,
      scaffoldBackgroundColor: BrandColors.bg,
      // Manrope is the brand typeface; we reference it by family name and fall
      // back to the platform default until the font is bundled at staging.
      fontFamily: 'Manrope',
    );

    return base.copyWith(
      appBarTheme: const AppBarTheme(
        backgroundColor: BrandColors.card,
        foregroundColor: BrandColors.text,
        elevation: 0,
        scrolledUnderElevation: 0.5,
        centerTitle: false,
        titleTextStyle: TextStyle(
          color: BrandColors.text,
          fontSize: 18,
          fontWeight: FontWeight.w700,
          fontFamily: 'Manrope',
        ),
      ),
      cardTheme: CardThemeData(
        color: BrandColors.card,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(BrandRadii.lg),
          side: const BorderSide(color: BrandColors.border),
        ),
      ),
      dividerTheme: const DividerThemeData(
        color: BrandColors.border,
        thickness: 1,
        space: 1,
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: BrandColors.card,
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(BrandRadii.md),
          borderSide: const BorderSide(color: BrandColors.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(BrandRadii.md),
          borderSide: const BorderSide(color: BrandColors.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(BrandRadii.md),
          borderSide: const BorderSide(color: BrandColors.teal, width: 1.6),
        ),
        labelStyle: const TextStyle(color: BrandColors.muted),
        hintStyle: const TextStyle(color: BrandColors.muted),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: BrandColors.teal,
          foregroundColor: BrandColors.onPrimary,
          minimumSize: const Size.fromHeight(48),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(BrandRadii.md),
          ),
          textStyle: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: BrandColors.teal,
          side: const BorderSide(color: BrandColors.teal),
          minimumSize: const Size.fromHeight(48),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(BrandRadii.md),
          ),
          textStyle: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(foregroundColor: BrandColors.teal),
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: BrandColors.card,
        indicatorColor: BrandColors.tealSoft,
        elevation: 3,
        labelTextStyle: WidgetStateProperty.resolveWith((states) {
          final selected = states.contains(WidgetState.selected);
          return TextStyle(
            fontSize: 11.5,
            fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
            color: selected ? BrandColors.tealDark : BrandColors.muted,
          );
        }),
        iconTheme: WidgetStateProperty.resolveWith((states) {
          final selected = states.contains(WidgetState.selected);
          return IconThemeData(
            color: selected ? BrandColors.tealDark : BrandColors.muted,
          );
        }),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: BrandColors.ink,
        contentTextStyle: const TextStyle(color: Colors.white),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(BrandRadii.md),
        ),
      ),
      textTheme: base.textTheme.apply(
        bodyColor: BrandColors.text,
        displayColor: BrandColors.text,
      ),
    );
  }
}
