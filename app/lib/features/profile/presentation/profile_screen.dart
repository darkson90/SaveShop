import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/widgets/async_view.dart';
import '../../../core/widgets/format.dart';
import '../../stores/presentation/stores_providers.dart';
import '../domain/stats.dart';
import 'profile_providers.dart';
import 'widgets/category_donut.dart';

class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final period = ref.watch(statsPeriodProvider);
    final stats = ref.watch(statsProvider);
    final profile = ref.watch(profileProvider).valueOrNull;

    return Scaffold(
      appBar: AppBar(
        title: Text(profile?.displayName?.isNotEmpty == true ? 'Ciao ${profile!.displayName}' : 'Profilo'),
        actions: [
          IconButton(
            tooltip: 'Impostazioni',
            icon: const Icon(Icons.settings_outlined),
            onPressed: () => context.push('/impostazioni'),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(statsProvider.future),
        child: ListView(padding: const EdgeInsets.all(16), children: [
          SegmentedButton<StatsPeriod>(
            segments: [for (final p in StatsPeriod.values) ButtonSegment(value: p, label: Text(p.label))],
            selected: {period},
            onSelectionChanged: (s) => ref.read(statsPeriodProvider.notifier).state = s.first,
          ),
          const SizedBox(height: 16),
          AsyncView(
            value: stats,
            onRetry: () => ref.invalidate(statsProvider),
            data: (s) => s.purchases == 0 ? const _NoPurchases() : _StatsBody(s),
          ),
        ]),
      ),
    );
  }
}

class _StatsBody extends StatelessWidget {
  const _StatsBody(this.s);
  final UserStats s;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [
        Expanded(child: _MetricCard(label: 'Risparmio totale', value: euro(s.totalSavedEur), highlight: true)),
        const SizedBox(width: 12),
        Expanded(child: _MetricCard(label: 'Risparmio medio', value: percent(s.avgSavingPct))),
      ]),
      const SizedBox(height: 12),
      Row(children: [
        Expanded(child: _MetricCard(label: 'Spese registrate', value: '${s.purchases}')),
        const SizedBox(width: 12),
        Expanded(child: _MetricCard(label: 'Totale speso', value: euro(s.totalSpentEur))),
      ]),
      const SizedBox(height: 24),
      Text('I tuoi prodotti più acquistati', style: theme.textTheme.titleMedium),
      const SizedBox(height: 8),
      Card(
        child: Column(children: [
          for (final (i, p) in s.topProducts.indexed)
            ListTile(
              leading: CircleAvatar(radius: 14, child: Text('${i + 1}')),
              title: Text(p.name),
              trailing: Text(p.times == 1 ? '1 spesa' : '${p.times} spese'),
            ),
        ]),
      ),
      const SizedBox(height: 24),
      Text('Spesa per categoria', style: theme.textTheme.titleMedium),
      const SizedBox(height: 12),
      Card(child: Padding(padding: const EdgeInsets.all(16), child: CategoryDonut(slices: s.categories))),
    ]);
  }
}

class _MetricCard extends StatelessWidget {
  const _MetricCard({required this.label, required this.value, this.highlight = false});

  final String label;
  final String value;
  final bool highlight;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Card(
      color: highlight ? scheme.primaryContainer : null,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 6),
          Text(value, style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w600)),
        ]),
      ),
    );
  }
}

class _NoPurchases extends StatelessWidget {
  const _NoPurchases();

  @override
  Widget build(BuildContext context) => const Padding(
        padding: EdgeInsets.symmetric(vertical: 48),
        child: Text(
          'Nessuna spesa registrata nel periodo.\nDopo il confronto, tocca "Ho fatto la spesa qui" per iniziare a misurare il risparmio.',
          textAlign: TextAlign.center,
        ),
      );
}
