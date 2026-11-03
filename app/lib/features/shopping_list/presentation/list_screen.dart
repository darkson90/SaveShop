import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/widgets/async_view.dart';
import '../../../core/widgets/format.dart';
import '../domain/models.dart';
import 'list_controller.dart';
import 'widgets/quick_add_field.dart';

class ListScreen extends ConsumerWidget {
  const ListScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(listControllerProvider);
    return Scaffold(
      appBar: AppBar(
        title: Text(list.valueOrNull?.name ?? 'Lista'),
        actions: [
          IconButton(
            tooltip: 'Confronta prezzi',
            icon: const Icon(Icons.compare_arrows),
            onPressed: () => context.go('/confronto'),
          ),
        ],
      ),
      body: Column(children: [
        const Padding(padding: EdgeInsets.fromLTRB(16, 8, 16, 8), child: QuickAddField()),
        const _FrequentChips(),
        const Divider(height: 1),
        Expanded(
          child: AsyncView(
            value: list,
            onRetry: () => ref.invalidate(listControllerProvider),
            data: (l) => l.items.isEmpty
                ? const _EmptyList()
                : RefreshIndicator(
                    onRefresh: () => ref.refresh(listControllerProvider.future),
                    child: ListView.builder(
                      padding: const EdgeInsets.only(bottom: 96),
                      itemCount: l.items.length,
                      itemBuilder: (_, i) => _ItemTile(item: l.items[i]),
                    ),
                  ),
          ),
        ),
      ]),
      floatingActionButton: (list.valueOrNull?.items.isNotEmpty ?? false)
          ? FloatingActionButton.extended(
              onPressed: () => context.go('/confronto'),
              icon: const Icon(Icons.savings_outlined),
              label: const Text('Dove costa meno?'),
            )
          : null,
    );
  }
}

/// Chip "Compri spesso": un tap aggiunge il prodotto.
class _FrequentChips extends ConsumerWidget {
  const _FrequentChips();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final frequent = ref.watch(frequentProductsProvider).valueOrNull ?? const [];
    if (frequent.isEmpty) return const SizedBox.shrink();
    return SizedBox(
      height: 48,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        itemCount: frequent.length,
        separatorBuilder: (_, __) => const SizedBox(width: 8),
        itemBuilder: (_, i) => Center(
          child: ActionChip(
            avatar: const Icon(Icons.history, size: 16),
            label: Text(frequent[i].name),
            onPressed: () => ref.read(listControllerProvider.notifier).addProduct(frequent[i].productId, frequent[i].name),
          ),
        ),
      ),
    );
  }
}

class _ItemTile extends ConsumerWidget {
  const _ItemTile({required this.item});

  final ListItem item;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ctrl = ref.read(listControllerProvider.notifier);
    final theme = Theme.of(context);
    return Dismissible(
      key: ValueKey(item.id),
      direction: DismissDirection.endToStart,
      background: Container(
        color: theme.colorScheme.errorContainer,
        alignment: Alignment.centerRight,
        padding: const EdgeInsets.only(right: 24),
        child: Icon(Icons.delete_outline, color: theme.colorScheme.onErrorContainer),
      ),
      onDismissed: (_) => ctrl.remove(item),
      child: ListTile(
        leading: Checkbox(value: item.checked, onChanged: item.pending ? null : (_) => ctrl.toggle(item)),
        title: Text(
          item.label,
          style: item.checked ? const TextStyle(decoration: TextDecoration.lineThrough) : null,
        ),
        subtitle: item.pending
            ? const Text('In attesa di connessione…')
            : item.isUnmatched
                ? Text('Non riconosciuto: tocca per scegliere il prodotto', style: TextStyle(color: theme.colorScheme.error))
                : Text(item.product?.category ?? ''),
        onTap: item.isUnmatched ? () => _pickProduct(context, ref) : null,
        trailing: Row(mainAxisSize: MainAxisSize.min, children: [
          IconButton(
            icon: const Icon(Icons.remove_circle_outline),
            onPressed: item.pending ? null : () => ctrl.setQuantity(item, item.unit == 'pz' ? item.quantity - 1 : item.quantity - 0.5),
          ),
          SizedBox(width: 52, child: Text(quantity(item.quantity, item.unit), textAlign: TextAlign.center)),
          IconButton(
            icon: const Icon(Icons.add_circle_outline),
            onPressed: item.pending ? null : () => ctrl.setQuantity(item, item.unit == 'pz' ? item.quantity + 1 : item.quantity + 0.5),
          ),
        ]),
      ),
    );
  }

  /// Abbinamento manuale di una voce libera al catalogo.
  Future<void> _pickProduct(BuildContext context, WidgetRef ref) async {
    final options = await ref.read(listRepositoryProvider).suggest(item.raw);
    if (!context.mounted) return;
    final chosen = await showModalBottomSheet<ProductRef>(
      context: context,
      builder: (ctx) => SafeArea(
        child: options.isEmpty
            ? const Padding(padding: EdgeInsets.all(24), child: Text('Nessun prodotto simile nel catalogo.'))
            : ListView(shrinkWrap: true, children: [
                const ListTile(title: Text('Quale prodotto intendevi?')),
                for (final p in options)
                  ListTile(title: Text(p.name), subtitle: Text(p.category ?? ''), onTap: () => Navigator.pop(ctx, p)),
              ]),
      ),
    );
    if (chosen != null) await ref.read(listControllerProvider.notifier).matchProduct(item, chosen.id);
  }
}

class _EmptyList extends StatelessWidget {
  const _EmptyList();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Text(
          'Scrivi un prodotto e premi Invio.\nPuoi indicare la quantità: "2 latte", "1,5 kg mele".',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyLarge,
        ),
      ),
    );
  }
}
