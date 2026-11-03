import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/widgets/format.dart';
import '../../profile/presentation/profile_providers.dart';
import '../../shopping_list/presentation/list_controller.dart';
import '../../stores/presentation/stores_providers.dart';
import '../domain/models.dart';

/// Prezzo di ogni articolo nel negozio, articoli mancanti e chiusura della spesa.
class StoreDetailScreen extends ConsumerStatefulWidget {
  const StoreDetailScreen({super.key, required this.result});

  final StoreResult result;

  @override
  ConsumerState<StoreDetailScreen> createState() => _StoreDetailScreenState();
}

class _StoreDetailScreenState extends ConsumerState<StoreDetailScreen> {
  bool _saving = false;

  Future<void> _purchase() async {
    final list = ref.read(listControllerProvider).valueOrNull;
    final ctx = await ref.read(searchContextProvider.future);
    if (list == null) return;
    setState(() => _saving = true);
    try {
      final res = await ref.read(listRepositoryProvider).purchase(
            list.id,
            storeId: widget.result.storeId,
            lat: ctx.point.lat,
            lng: ctx.point.lng,
            radiusKm: ctx.radiusKm,
          );
      await ref.read(listControllerProvider.notifier).startNewList();
      ref.invalidate(statsProvider);
      if (!mounted) return;
      final saved = (res['savedEur'] as num).toDouble();
      final pct = (res['savedPct'] as num).toDouble();
      await showDialog<void>(
        context: context,
        builder: (dialogCtx) => AlertDialog(
          icon: const Icon(Icons.savings_outlined),
          title: const Text('Spesa registrata'),
          content: Text(saved > 0
              ? 'Hai risparmiato ${euro(saved)} (${percent(pct)}) rispetto al negozio più caro della zona.'
              : 'Spesa salvata nello storico. Questa volta i prezzi erano allineati.'),
          actions: [TextButton(onPressed: () => Navigator.pop(dialogCtx), child: const Text('Ok'))],
        ),
      );
      if (mounted) context.go('/lista');
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.result;
    final items = ref.watch(listControllerProvider).valueOrNull?.items ?? const [];
    final byId = {for (final i in items) i.id: i};
    final pricedIds = r.items.map((i) => i.itemId).toSet();
    final missing = items.where((i) => i.product != null && !i.checked && !pricedIds.contains(i.id)).toList();
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(title: Text(r.name)),
      body: ListView(padding: const EdgeInsets.only(bottom: 120), children: [
        ListTile(
          title: Text(euro(r.total), style: theme.textTheme.headlineSmall),
          subtitle: Text('${km(r.distanceKm)} · ${r.items.length} articoli disponibili'),
        ),
        const Divider(),
        for (final p in r.items)
          ListTile(
            title: Text(byId[p.itemId]?.label ?? 'Articolo'),
            subtitle: Text(byId[p.itemId] == null ? '' : quantity(byId[p.itemId]!.quantity, byId[p.itemId]!.unit)),
            trailing: Row(mainAxisSize: MainAxisSize.min, children: [
              if (p.promo)
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: Chip(
                    label: Text(p.loyaltyOnly ? 'Promo carta' : 'Offerta'),
                    visualDensity: VisualDensity.compact,
                  ),
                ),
              Text(euro(p.unitPrice)),
            ]),
          ),
        if (missing.isNotEmpty) ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
            child: Text('Non disponibili qui', style: theme.textTheme.titleSmall),
          ),
          for (final m in missing)
            ListTile(title: Text(m.label), leading: Icon(Icons.remove_shopping_cart_outlined, color: theme.colorScheme.error)),
        ],
      ]),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: FilledButton.icon(
            onPressed: _saving ? null : _purchase,
            icon: _saving
                ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.check),
            label: const Padding(padding: EdgeInsets.symmetric(vertical: 12), child: Text('Ho fatto la spesa qui')),
          ),
        ),
      ),
    );
  }
}
