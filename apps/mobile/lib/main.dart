// App entry. We hydrate the persisted session BEFORE the first frame so the very
// first authenticated request already carries the cookie/Bearer, then kick off
// AuthController.bootstrap() (validate the session → Home or Login).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'app.dart';
import 'core/providers.dart';
import 'core/session.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Build + hydrate the session up front so the API client interceptor replays
  // it from request #1 (no flash of "logged out" on a warm start).
  const storage = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
  final session = Session(storage);
  await session.load();

  final container = ProviderContainer(
    overrides: [sessionProvider.overrideWithValue(session)],
  );

  // Validate the session (or fall through to Login) before the UI settles.
  // ignore: unawaited_futures
  container.read(authControllerProvider.notifier).bootstrap();

  runApp(
    UncontrolledProviderScope(
      container: container,
      child: const DriftHrApp(),
    ),
  );
}
