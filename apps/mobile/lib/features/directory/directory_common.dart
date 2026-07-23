// Shared directory atoms: a colleague name resolver and an avatar (photo when the
// row carries a usable http photoUrl, else tinted initials).

import 'package:flutter/material.dart';

import '../../theme/app_theme.dart';

String colleagueName(Map<String, dynamic>? c) {
  if (c == null) return 'A colleague';
  final n = (c['name'] ?? '').toString().trim();
  if (n.isNotEmpty) return n;
  return (c['code'] ?? 'A colleague').toString();
}

String _initials(String name) {
  final parts = name.trim().split(RegExp(r'\s+')).where((s) => s.isNotEmpty).toList();
  if (parts.isEmpty) return '?';
  if (parts.length == 1) return parts.first.characters.first.toUpperCase();
  return (parts.first.characters.first + parts.last.characters.first).toUpperCase();
}

class DirectoryAvatar extends StatelessWidget {
  const DirectoryAvatar({super.key, required this.name, this.photoUrl, this.size = 40});

  final String name;
  final String? photoUrl;
  final double size;

  @override
  Widget build(BuildContext context) {
    final url = photoUrl?.trim() ?? '';
    final usePhoto = url.startsWith('http://') || url.startsWith('https://');
    if (usePhoto) {
      return ClipOval(
        child: Image.network(
          url,
          width: size,
          height: size,
          fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => _initialsAvatar(),
        ),
      );
    }
    return _initialsAvatar();
  }

  Widget _initialsAvatar() => Container(
        width: size,
        height: size,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: BrandColors.tealDark.withValues(alpha: 0.14),
          shape: BoxShape.circle,
        ),
        child: Text(
          _initials(name),
          style: TextStyle(
            color: BrandColors.tealDark,
            fontWeight: FontWeight.w800,
            fontSize: size * 0.38,
          ),
        ),
      );
}
