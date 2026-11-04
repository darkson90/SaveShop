import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/config.dart';
import '../../app/providers.dart';

/// Parametri pubblici impostati dal pannello di amministrazione (GET /config/public).
class PublicConfig {
  const PublicConfig({this.maintenanceMessage = '', this.minSupportedVersion = '0.0.0', this.maxRadiusKm = 25});

  final String maintenanceMessage;
  final String minSupportedVersion;
  final int maxRadiusKm;

  bool get updateRequired => compareVersions(AppConfig.appVersion, minSupportedVersion) < 0;

  factory PublicConfig.fromJson(Map<String, dynamic> j) {
    final v = (j['values'] as Map?)?.cast<String, dynamic>() ?? const {};
    return PublicConfig(
      maintenanceMessage: (v['app.maintenanceMessage'] as String?)?.trim() ?? '',
      minSupportedVersion: v['app.minSupportedVersion'] as String? ?? '0.0.0',
      maxRadiusKm: (v['geo.maxRadiusKm'] as num?)?.toInt() ?? 25,
    );
  }
}

/// -1 se a < b, 0 se uguali, 1 se a > b ("1.2.3").
int compareVersions(String a, String b) {
  List<int> parts(String v) => v.split('.').map((p) => int.tryParse(p) ?? 0).toList();
  final pa = parts(a), pb = parts(b);
  for (var i = 0; i < 3; i++) {
    final x = i < pa.length ? pa[i] : 0, y = i < pb.length ? pb[i] : 0;
    if (x != y) return x < y ? -1 : 1;
  }
  return 0;
}

/// Senza rete o senza Config Service l'app funziona con i valori predefiniti.
final publicConfigProvider = FutureProvider<PublicConfig>((ref) async {
  try {
    return PublicConfig.fromJson(await ref.watch(apiClientProvider).get('/config/public'));
  } catch (_) {
    return const PublicConfig();
  }
});

/// Avviso del pannello (manutenzione) e invito ad aggiornare l'app, in cima alla lista.
class AppNoticeBanner extends ConsumerWidget {
  const AppNoticeBanner({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final config = ref.watch(publicConfigProvider).valueOrNull;
    if (config == null) return const SizedBox.shrink();
    final scheme = Theme.of(context).colorScheme;
    final notices = <(IconData, String)>[
      if (config.updateRequired) (Icons.system_update, 'È disponibile una versione più recente dell\'app: aggiornala per continuare a usarla al meglio.'),
      if (config.maintenanceMessage.isNotEmpty) (Icons.campaign_outlined, config.maintenanceMessage),
    ];
    if (notices.isEmpty) return const SizedBox.shrink();
    return Column(children: [
      for (final (icon, text) in notices)
        Container(
          width: double.infinity,
          color: scheme.tertiaryContainer,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          child: Row(children: [
            Icon(icon, size: 20, color: scheme.onTertiaryContainer),
            const SizedBox(width: 10),
            Expanded(child: Text(text, style: TextStyle(color: scheme.onTertiaryContainer))),
          ]),
        ),
    ]);
  }
}
