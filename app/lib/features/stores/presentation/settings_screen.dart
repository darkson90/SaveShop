import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/providers.dart';
import '../../auth/presentation/auth_controller.dart';
import '../../offers/offers.dart';
import '../data/stores_repository.dart';
import 'stores_providers.dart';

class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  double? _radius;

  Future<void> _saveRadius(double km) async {
    try {
      await ref.read(storesRepositoryProvider).updateRadius(km.round());
      ref.invalidate(profileProvider);
    } catch (e) {
      _snack(e.toString());
    }
  }

  /// Le offerte richiedono una posizione di casa: se manca la proponiamo dal GPS.
  Future<void> _toggleOffers(bool enabled) async {
    try {
      if (enabled && ref.read(profileProvider).valueOrNull?.homeLat == null) await _setHomeHere(silent: true);
      await ref.read(apiClientProvider).patch('/notifications/preferences', body: {'offersEnabled': enabled});
      ref.invalidate(offersEnabledProvider);
      final push = ref.read(pushServiceProvider);
      if (enabled && !await push.register()) {
        _snack(push.isAvailable
            ? 'Permesso notifiche negato: vedrai le offerte nella schermata "Offerte per te".'
            : 'Notifiche push non configurate: vedrai le offerte nella schermata "Offerte per te".');
      }
      if (!enabled) await push.unregister();
    } catch (e) {
      _snack(e.toString());
    }
  }

  Future<void> _setHomeHere({bool silent = false}) async {
    final point = await ref.read(locationServiceProvider).current();
    if (!point.fromGps) {
      _snack('Posizione non disponibile: attiva il GPS e concedi il permesso.');
      return;
    }
    await ref.read(storesRepositoryProvider).updateHome(point.lat, point.lng);
    ref.invalidate(profileProvider);
    ref.invalidate(searchContextProvider);
    if (!silent) _snack('Posizione di casa aggiornata');
  }

  Future<void> _addCard() async {
    final chains = await ref.read(chainsProvider.future);
    if (!mounted) return;
    final result = await showDialog<(Chain, String)>(context: context, builder: (_) => _AddCardDialog(chains: chains));
    if (result == null) return;
    try {
      await ref.read(storesRepositoryProvider).addCard(result.$1.id, result.$2);
      ref.invalidate(loyaltyCardsProvider);
    } catch (e) {
      _snack(e.toString());
    }
  }

  Future<void> _deleteAccount() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Eliminare l\'account?'),
        content: const Text('Liste, storico acquisti, carte e preferenze verranno cancellati definitivamente.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Annulla')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Elimina')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await ref.read(storesRepositoryProvider).deleteAccount();
      await ref.read(authControllerProvider.notifier).logout();
    } catch (e) {
      _snack(e.toString());
    }
  }

  void _snack(String msg) {
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    final profile = ref.watch(profileProvider).valueOrNull;
    final cards = ref.watch(loyaltyCardsProvider).valueOrNull ?? const <LoyaltyCard>[];
    final chains = {for (final c in ref.watch(chainsProvider).valueOrNull ?? const <Chain>[]) c.id: c.name};
    final radius = _radius ?? profile?.defaultRadiusKm.toDouble() ?? 10;
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(title: const Text('Impostazioni')),
      body: ListView(children: [
        ListTile(title: const Text('Raggio di ricerca'), trailing: Text('${radius.round()} km')),
        Slider(
          value: radius,
          min: 1,
          max: 25,
          divisions: 24,
          label: '${radius.round()} km',
          onChanged: (v) => setState(() => _radius = v),
          onChangeEnd: _saveRadius,
        ),
        ListTile(
          leading: const Icon(Icons.home_outlined),
          title: const Text('Posizione di casa'),
          subtitle: Text(profile?.homeLat == null
              ? 'Non impostata: usata quando il GPS non è disponibile e per le offerte'
              : 'Impostata · tocca per usare la posizione attuale'),
          onTap: () => _setHomeHere(),
        ),
        SwitchListTile(
          secondary: const Icon(Icons.notifications_outlined),
          title: const Text('Avvisami delle offerte'),
          subtitle: const Text('Promo sui prodotti che compri spesso, nei negozi vicini a casa e non esclusi'),
          value: ref.watch(offersEnabledProvider).valueOrNull ?? false,
          onChanged: _toggleOffers,
        ),
        const Divider(),
        ListTile(
          leading: const Icon(Icons.block),
          title: const Text('Negozi esclusi'),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => context.push('/impostazioni/esclusi'),
        ),
        const Divider(),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
          child: Text('Fidelity card', style: theme.textTheme.titleSmall),
        ),
        for (final c in cards)
          ListTile(
            leading: const Icon(Icons.credit_card),
            title: Text(chains[c.chainId] ?? 'Insegna'),
            subtitle: Text('•••• ${c.last4}'),
            trailing: IconButton(
              icon: const Icon(Icons.delete_outline),
              onPressed: () async {
                await ref.read(storesRepositoryProvider).removeCard(c.id);
                ref.invalidate(loyaltyCardsProvider);
              },
            ),
          ),
        ListTile(leading: const Icon(Icons.add_card), title: const Text('Aggiungi carta'), onTap: _addCard),
        const Divider(),
        ListTile(
          leading: const Icon(Icons.logout),
          title: const Text('Esci'),
          subtitle: profile == null ? null : Text(profile.email),
          onTap: () => ref.read(authControllerProvider.notifier).logout(),
        ),
        ListTile(
          leading: Icon(Icons.delete_forever_outlined, color: theme.colorScheme.error),
          title: Text('Elimina account', style: TextStyle(color: theme.colorScheme.error)),
          onTap: _deleteAccount,
        ),
      ]),
    );
  }
}

class _AddCardDialog extends StatefulWidget {
  const _AddCardDialog({required this.chains});
  final List<Chain> chains;

  @override
  State<_AddCardDialog> createState() => _AddCardDialogState();
}

class _AddCardDialogState extends State<_AddCardDialog> {
  Chain? _chain;
  final _number = TextEditingController();

  @override
  void dispose() {
    _number.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Nuova fidelity card'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        DropdownButtonFormField<Chain>(
          initialValue: _chain,
          decoration: const InputDecoration(labelText: 'Insegna'),
          items: [for (final c in widget.chains) DropdownMenuItem(value: c, child: Text(c.name))],
          onChanged: (c) => setState(() => _chain = c),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _number,
          keyboardType: TextInputType.number,
          decoration: const InputDecoration(labelText: 'Numero carta'),
        ),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Annulla')),
        FilledButton(
          onPressed: () {
            if (_chain == null || _number.text.trim().length < 4) return;
            Navigator.pop(context, (_chain!, _number.text.trim()));
          },
          child: const Text('Salva'),
        ),
      ],
    );
  }
}
