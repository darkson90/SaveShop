import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/widgets/async_view.dart';
import '../../comparison/presentation/comparison_providers.dart';
import '../data/stores_repository.dart';
import 'stores_providers.dart';

/// Negozi e insegne esclusi dai confronti, con ripristino in un tap.
class ExcludedStoresScreen extends ConsumerWidget {
  const ExcludedStoresScreen({super.key});

  Future<void> _run(BuildContext context, WidgetRef ref, Future<void> Function() fn) async {
    try {
      await fn();
      ref.invalidate(exclusionsProvider);
      ref.invalidate(comparisonProvider);
    } catch (e) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  Future<void> _excludeChain(BuildContext context, WidgetRef ref) async {
    final chains = await ref.read(chainsProvider.future);
    if (!context.mounted) return;
    final chosen = await showModalBottomSheet<Chain>(
      context: context,
      builder: (ctx) => SafeArea(
        child: ListView(shrinkWrap: true, children: [
          const ListTile(title: Text('Escludi un\'intera insegna')),
          for (final c in chains) ListTile(title: Text(c.name), onTap: () => Navigator.pop(ctx, c)),
        ]),
      ),
    );
    if (chosen != null && context.mounted) {
      await _run(context, ref, () => ref.read(storesRepositoryProvider).excludeChain(chosen.id));
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final exclusions = ref.watch(exclusionsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Negozi esclusi')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _excludeChain(context, ref),
        icon: const Icon(Icons.block),
        label: const Text('Escludi insegna'),
      ),
      body: AsyncView(
        value: exclusions,
        onRetry: () => ref.invalidate(exclusionsProvider),
        data: (items) => items.isEmpty
            ? const Center(
                child: Padding(
                  padding: EdgeInsets.all(32),
                  child: Text(
                    'Nessun negozio escluso.\nNel confronto, scorri un negozio verso sinistra per escluderlo.',
                    textAlign: TextAlign.center,
                  ),
                ),
              )
            : ListView(children: [
                for (final e in items)
                  ListTile(
                    leading: Icon(e.kind == 'chain' ? Icons.storefront : Icons.store_outlined),
                    title: Text(e.label),
                    subtitle: Text(e.kind == 'chain' ? 'Intera insegna' : 'Punto vendita'),
                    trailing: TextButton(
                      onPressed: () => _run(context, ref, () => ref.read(storesRepositoryProvider).restore(e.id)),
                      child: const Text('Ripristina'),
                    ),
                  ),
              ]),
      ),
    );
  }
}
