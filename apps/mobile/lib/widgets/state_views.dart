// Loading / empty / error scaffolding used across every screen, plus a generic
// AsyncValue renderer so each feature gets consistent loading→data→error UX with
// pull-to-refresh for free.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../theme/app_theme.dart';
import '../core/api_client.dart';

class LoadingView extends StatelessWidget {
  const LoadingView({super.key});

  @override
  Widget build(BuildContext context) => const Center(
        child: Padding(
          padding: EdgeInsets.all(40),
          child: CircularProgressIndicator(strokeWidth: 2.6),
        ),
      );
}

class EmptyView extends StatelessWidget {
  const EmptyView({super.key, required this.text, this.icon = Icons.inbox_outlined});

  final String text;
  final IconData icon;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 40, color: BrandColors.muted.withValues(alpha: 0.6)),
              const SizedBox(height: 12),
              Text(
                text,
                textAlign: TextAlign.center,
                style: const TextStyle(color: BrandColors.muted, fontSize: 14),
              ),
            ],
          ),
        ),
      );
}

class ErrorView extends StatelessWidget {
  const ErrorView({super.key, required this.message, this.onRetry});

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, color: BrandColors.danger, size: 36),
              const SizedBox(height: 12),
              Text(
                message,
                textAlign: TextAlign.center,
                style: const TextStyle(color: BrandColors.text, fontSize: 14),
              ),
              if (onRetry != null) ...[
                const SizedBox(height: 16),
                OutlinedButton(onPressed: onRetry, child: const Text('Try again')),
              ],
            ],
          ),
        ),
      );
}

/// Inline banner for a form/page-level error message.
class ErrorBanner extends StatelessWidget {
  const ErrorBanner({super.key, required this.message});

  final String message;

  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: BrandColors.dangerSoft,
          borderRadius: BorderRadius.circular(BrandRadii.md),
          border: Border.all(color: BrandColors.danger.withValues(alpha: 0.3)),
        ),
        child: Text(
          message,
          style: const TextStyle(color: BrandColors.danger, fontSize: 13),
        ),
      );
}

/// Inline success banner (brand teal).
class SuccessBanner extends StatelessWidget {
  const SuccessBanner({super.key, required this.message});

  final String message;

  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: BrandColors.teal,
          borderRadius: BorderRadius.circular(BrandRadii.md),
        ),
        child: Text(
          message,
          style: const TextStyle(color: BrandColors.onPrimary, fontSize: 13, fontWeight: FontWeight.w600),
        ),
      );
}

/// Renders an [AsyncValue] with consistent loading/error/data handling and a
/// pull-to-refresh wrapper. `treat404AsEmpty` degrades a not-yet-deployed route
/// to a friendly empty state (the ESS web does the same for new contract routes).
class AsyncView<T> extends ConsumerWidget {
  const AsyncView({
    super.key,
    required this.value,
    required this.onRefresh,
    required this.data,
    this.emptyText,
    this.treat404AsEmpty = false,
  });

  final AsyncValue<T> value;
  final Future<void> Function() onRefresh;
  final Widget Function(T data) data;
  final String? emptyText;
  final bool treat404AsEmpty;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return value.when(
      loading: () => const LoadingView(),
      error: (err, _) {
        if (treat404AsEmpty && err is ApiException && err.isNotFound) {
          return _wrap(EmptyView(text: emptyText ?? 'Nothing here yet.'));
        }
        final msg = err is ApiException ? err.message : 'Something went wrong.';
        return ErrorView(message: msg, onRetry: onRefresh);
      },
      data: (d) => _wrap(data(d)),
    );
  }

  Widget _wrap(Widget child) => RefreshIndicator(
        onRefresh: onRefresh,
        color: BrandColors.teal,
        child: child,
      );
}
