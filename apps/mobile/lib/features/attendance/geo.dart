// Geolocation for the attendance punch. Handles the permission dance and returns
// a best-effort position; a denied permission is NOT fatal — the punch still
// goes through (the server records WEB-source punches without coordinates), the
// app just attaches lat/long when it can.

import 'package:geolocator/geolocator.dart';

class GeoResult {
  const GeoResult({this.position, this.error});

  final Position? position;

  /// A human note when location was unavailable (shown subtly; never blocks the punch).
  final String? error;

  Map<String, dynamic> get coords => position == null
      ? const {}
      : {
          'latitude': position!.latitude,
          'longitude': position!.longitude,
          'accuracy': position!.accuracy,
        };
}

class Geo {
  Geo._();

  static Future<GeoResult> currentPosition() async {
    try {
      final serviceOn = await Geolocator.isLocationServiceEnabled();
      if (!serviceOn) {
        return const GeoResult(error: 'Location services are off — punch recorded without location.');
      }

      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        return const GeoResult(error: 'Location permission denied — punch recorded without location.');
      }

      // geolocator 12.x API — `locationSettings` arrived in a later major.
      // ignore: deprecated_member_use
      final pos = await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.medium,
      );
      return GeoResult(position: pos);
    } catch (_) {
      return const GeoResult(error: 'Could not read location — punch recorded without it.');
    }
  }
}
