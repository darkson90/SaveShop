import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../core/widgets/async_view.dart';
import '../../core/widgets/format.dart';
import '../shopping_list/presentation/list_controller.dart';

class Offer {
  const Offer({
    required this.productId,
    required this.productName,
    required this.storeName,
    required this.price,
    required this.promoPrice,
    required this.loyaltyOnly,
    required this.read,
  });

  final String productId;
  final String productName;
  final String storeName;
  final double price;
  final double promoPrice;
  final bool loyaltyOnly;
  final bool read;

  int get discountPct => ((price - promoPrice) / price * 100).round();

  factory Offer.fromJson(Map<String, dynamic> j) => Offer(
        productId: j['productId'] as String,
        productName: j['productName'] as String,
        storeName: j['storeName'] as String,
        price: (j['price'] as num).toDouble(),
        promoPrice: (j['promoPrice'] as num).toDouble(),
        loyaltyOnly: j['loyaltyOnly'] as bool? ?? false,
        read: j['read'] as bool? ?? false,
      );
}

class OffersInbox {
  const OffersInbox(this.unread, this.items);
  final int unread;
  final List<Offer> items;
}

final offersProvider = FutureProvider.autoDispose<OffersInbox>((ref) async {
  final res = await ref.watch(apiClientProvider).get('/notifications');
  return OffersInbox(
    (res['unread'] as num).toInt(),
    (res['items'] as List).map((e) => Offer.fromJson(e as Map<String, dynamic>)).toList(),
  );
});

/// Consenso alle notifiche offerte (spento finché l'utente non lo attiva).
final offersEnabledProvider = FutureProvider.autoDispose<bool>((ref) async {
  final res = await ref.watch(apiClientProvider).get('/notifications/preferences');
  return res['offersEnabled'] as bool? ?? false;
});

/// All'avvio di una sessione: se l'utente ha attivato le offerte, aggiorna il token del dispositivo.
final pushBootstrapProvider = FutureProvider.autoDispose<void>((ref) async {
  if (await ref.watch(offersEnabledProvider.future)) await ref.read(pushServiceProvider).register();
});

/// Icona con il numero di offerte non lette, nella barra della lista.
class OffersBell extends ConsumerWidget {
  const OffersBell({super.key, required this.onPressed});
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(pushBootstrapProvider);
    final unread = ref.watch(offersProvider).valueOrNull?.unread ?? 0;
    return IconButton(
      tooltip: 'Offerte per te',
      onPressed: onPressed,
      icon: Badge(isLabelVisible: unread > 0, label: Text('$unread'), child: const Icon(Icons.local_offer_outlined)),
    );
  }
}

/// Casella "Offerte per te": promo sui prodotti comprati spesso, nei negozi non esclusi.
class OffersScreen extends ConsumerStatefulWidget {
  const OffersScreen({super.key});

  @override
  ConsumerState<OffersScreen> createState() => _OffersScreenState();
}

class _OffersScreenState extends ConsumerState<OffersScreen> {
  @override
  void initState() {
    super.initState();
    // Aprire la casella segna tutto come letto; il badge si aggiorna al ritorno.
    Future.microtask(() async {
      try {
        await ref.read(apiClientProvider).post('/notifications/read');
        ref.invalidate(offersProvider);
      } catch (_) {}
    });
  }

  @override
  Widget build(BuildContext context) {
    final inbox = ref.watch(offersProvider);
    final enabled = ref.watch(offersEnabledProvider).valueOrNull;
    return Scaffold(
      appBar: AppBar(title: const Text('Offerte per te')),
      body: AsyncView(
        value: inbox,
        onRetry: () => ref.invalidate(offersProvider),
        data: (data) => RefreshIndicator(
          onRefresh: () => ref.refresh(offersProvider.future),
          child: ListView(children: [
            if (enabled == false)
              const Card(
                margin: EdgeInsets.all(16),
                child: ListTile(
                  leading: Icon(Icons.notifications_off_outlined),
                  title: Text('Avvisi offerte disattivati'),
                  subtitle: Text('Attivali nelle impostazioni per ricevere le promo sui prodotti che compri spesso.'),
                ),
              ),
            if (data.items.isEmpty)
              const Padding(
                padding: EdgeInsets.all(32),
                child: Text(
                  'Nessuna offerta per ora. Segnaliamo le promo sui prodotti che aggiungi spesso, nei negozi vicini a casa.',
                  textAlign: TextAlign.center,
                ),
              ),
            for (final o in data.items)
              ListTile(
                leading: CircleAvatar(child: Text('-${o.discountPct}%', style: const TextStyle(fontSize: 12))),
                title: Text(o.productName, style: o.read ? null : const TextStyle(fontWeight: FontWeight.w600)),
                subtitle: Text('${o.storeName}${o.loyaltyOnly ? ' · con la carta' : ''}'),
                trailing: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.end, children: [
                  Text(euro(o.promoPrice), style: Theme.of(context).textTheme.titleMedium),
                  Text(euro(o.price), style: const TextStyle(decoration: TextDecoration.lineThrough, fontSize: 12)),
                ]),
                onLongPress: () async {
                  await ref.read(listControllerProvider.notifier).addProduct(o.productId, o.productName);
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${o.productName} aggiunto alla lista')));
                  }
                },
              ),
          ]),
        ),
      ),
    );
  }
}
