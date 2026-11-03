import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:google_mlkit_text_recognition/google_mlkit_text_recognition.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/widgets/format.dart';
import '../../comparison/domain/models.dart';
import '../../profile/presentation/profile_providers.dart';
import '../../stores/presentation/stores_providers.dart';
import 'list_controller.dart';

/// Una riga dello scontrino letta dal server, con l'articolo della lista abbinato (modificabile).
class _Row {
  _Row({required this.text, required this.amount, required this.unitPrice, required this.itemId, required this.confidence});

  final String text;
  final double amount;
  final double unitPrice;
  String? itemId;
  final double? confidence;
  bool included = true;
}

/// Chiusura della spesa con lo scontrino: foto → testo letto sul telefono (ML Kit, la foto non lascia
/// il dispositivo) → righe abbinate dal server → controllo dell'utente → prezzi realmente pagati.
class ReceiptScreen extends ConsumerStatefulWidget {
  const ReceiptScreen({super.key, required this.store});

  final StoreResult store;

  @override
  ConsumerState<ReceiptScreen> createState() => _ReceiptScreenState();
}

class _ReceiptScreenState extends ConsumerState<ReceiptScreen> {
  List<_Row>? _rows;
  double? _total;
  double? _mismatch;
  String? _status;
  bool _busy = false;

  Future<void> _scan(ImageSource source) async {
    final photo = await ImagePicker().pickImage(source: source, imageQuality: 90, maxWidth: 2400);
    if (photo == null) return;
    setState(() {
      _busy = true;
      _status = 'Lettura dello scontrino…';
    });
    final recognizer = TextRecognizer(script: TextRecognitionScript.latin);
    try {
      final recognized = await recognizer.processImage(InputImage.fromFilePath(photo.path));
      await _read(rowsFromRecognizedText(recognized));
    } catch (e) {
      _fail('Impossibile leggere la foto: $e');
    } finally {
      await recognizer.close();
    }
  }

  /// Alternativa per emulatori e test: incollare il testo dello scontrino.
  Future<void> _paste() async {
    final controller = TextEditingController();
    final text = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Testo dello scontrino'),
        content: TextField(controller: controller, maxLines: 10, decoration: const InputDecoration(hintText: 'LATTE PS 1L   1,29')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Annulla')),
          FilledButton(onPressed: () => Navigator.pop(ctx, controller.text), child: const Text('Leggi')),
        ],
      ),
    );
    if (text == null || text.trim().isEmpty) return;
    setState(() => _busy = true);
    await _read(text);
  }

  Future<void> _read(String text) async {
    final list = ref.read(listControllerProvider).valueOrNull;
    if (list == null) return;
    setState(() => _status = 'Abbinamento agli articoli della lista…');
    try {
      final res = await ref.read(listRepositoryProvider).readReceipt(list.id, text);
      setState(() {
        _rows = [
          for (final l in (res['lines'] as List).cast<Map<String, dynamic>>())
            _Row(
              text: l['text'] as String,
              amount: (l['amount'] as num).toDouble(),
              unitPrice: (l['unitPrice'] as num).toDouble(),
              itemId: (l['match'] as Map<String, dynamic>?)?['itemId'] as String?,
              confidence: ((l['match'] as Map<String, dynamic>?)?['confidence'] as num?)?.toDouble(),
            ),
        ];
        _total = (res['total'] as num?)?.toDouble();
        _mismatch = (res['totalMismatch'] as num?)?.toDouble();
        _busy = false;
        _status = null;
      });
    } catch (e) {
      _fail(e.toString());
    }
  }

  Future<void> _confirm() async {
    final list = ref.read(listControllerProvider).valueOrNull;
    final rows = _rows;
    if (list == null || rows == null) return;
    final paid = [
      for (final r in rows)
        if (r.included && r.itemId != null) (itemId: r.itemId!, unitPaid: r.unitPrice),
    ];
    setState(() => _busy = true);
    try {
      final ctx = await ref.read(searchContextProvider.future);
      final res = await ref.read(listRepositoryProvider).purchase(
            list.id,
            storeId: widget.store.storeId,
            lat: ctx.point.lat,
            lng: ctx.point.lng,
            radiusKm: ctx.radiusKm,
            paidPrices: paid,
          );
      await ref.read(listControllerProvider.notifier).startNewList();
      ref.invalidate(statsProvider);
      if (!mounted) return;
      final saved = (res['savedEur'] as num).toDouble();
      await showDialog<void>(
        context: context,
        builder: (dialogCtx) => AlertDialog(
          icon: const Icon(Icons.receipt_long),
          title: const Text('Spesa registrata'),
          content: Text(
            'Pagati ${euro((res['totalPaid'] as num).toDouble())} con i prezzi dello scontrino. '
            '${saved > 0 ? 'Hai risparmiato ${euro(saved)} rispetto al negozio più caro della zona.' : ''}',
          ),
          actions: [TextButton(onPressed: () => Navigator.pop(dialogCtx), child: const Text('Ok'))],
        ),
      );
      if (mounted) context.go('/lista');
    } catch (e) {
      _fail(e.toString());
    }
  }

  void _fail(String msg) {
    if (!mounted) return;
    setState(() {
      _busy = false;
      _status = null;
    });
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    final items = ref.watch(listControllerProvider).valueOrNull?.items ?? const [];
    final rows = _rows;
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(title: Text('Scontrino · ${widget.store.name}')),
      body: _busy && rows == null
          ? Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
              const CircularProgressIndicator(),
              const SizedBox(height: 12),
              Text(_status ?? ''),
            ]))
          : rows == null
              ? _Start(onCamera: () => _scan(ImageSource.camera), onGallery: () => _scan(ImageSource.gallery), onPaste: _paste)
              : ListView(padding: const EdgeInsets.only(bottom: 120), children: [
                  if (_mismatch != null && _mismatch!.abs() > 0.01)
                    MaterialBanner(
                      content: Text('Il totale stampato (${euro(_total!)}) non coincide con le righe lette: '
                          'qualche riga potrebbe mancare. Puoi riprovare con una foto più nitida.'),
                      actions: [TextButton(onPressed: () => setState(() => _rows = null), child: const Text('Riprova'))],
                    ),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                    child: Text('Controlla gli abbinamenti: le righe senza articolo restano fuori dal calcolo.',
                        style: theme.textTheme.bodySmall),
                  ),
                  for (final r in rows)
                    CheckboxListTile(
                      value: r.included,
                      onChanged: (v) => setState(() => r.included = v ?? false),
                      title: Text(r.text),
                      subtitle: DropdownButton<String?>(
                        isExpanded: true,
                        value: items.any((i) => i.id == r.itemId) ? r.itemId : null,
                        hint: const Text('Abbina a un articolo'),
                        items: [
                          const DropdownMenuItem<String?>(value: null, child: Text('Nessun articolo')),
                          for (final i in items.where((i) => i.product != null))
                            DropdownMenuItem<String?>(value: i.id, child: Text(i.label, overflow: TextOverflow.ellipsis)),
                        ],
                        onChanged: (v) => setState(() => r.itemId = v),
                      ),
                      secondary: Text(euro(r.amount), style: theme.textTheme.titleMedium),
                    ),
                ]),
      bottomNavigationBar: rows == null
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: FilledButton.icon(
                  onPressed: _busy ? null : _confirm,
                  icon: const Icon(Icons.check),
                  label: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Text('Registra la spesa (${rows.where((r) => r.included && r.itemId != null).length} prezzi reali)'),
                  ),
                ),
              ),
            ),
    );
  }
}

class _Start extends StatelessWidget {
  const _Start({required this.onCamera, required this.onGallery, required this.onPaste});

  final VoidCallback onCamera;
  final VoidCallback onGallery;
  final VoidCallback onPaste;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(Icons.receipt_long, size: 56, color: Theme.of(context).colorScheme.primary),
          const SizedBox(height: 12),
          const Text(
            'Fotografa lo scontrino: useremo i prezzi che hai pagato davvero per calcolare il risparmio. '
            'Il testo viene letto sul telefono, la foto non viene inviata.',
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 24),
          FilledButton.icon(onPressed: onCamera, icon: const Icon(Icons.photo_camera), label: const Text('Fotografa')),
          const SizedBox(height: 8),
          OutlinedButton.icon(onPressed: onGallery, icon: const Icon(Icons.photo_library_outlined), label: const Text('Dalla galleria')),
          TextButton(onPressed: onPaste, child: const Text('Incolla il testo')),
        ]),
      ),
    );
  }
}

/// ML Kit restituisce blocchi per colonna (descrizione a sinistra, prezzo a destra): qui le linee
/// vengono ricomposte in righe in base alla posizione verticale, da sinistra a destra.
String rowsFromRecognizedText(RecognizedText recognized) {
  final lines = <({Rect box, String text})>[
    for (final block in recognized.blocks)
      for (final line in block.lines) (box: line.boundingBox, text: line.text),
  ]..sort((a, b) => a.box.center.dy.compareTo(b.box.center.dy));

  final rows = <List<({Rect box, String text})>>[];
  for (final line in lines) {
    final row = rows.isEmpty ? null : rows.last;
    final sameRow = row != null && (line.box.center.dy - row.first.box.center.dy).abs() < row.first.box.height * 0.6;
    if (sameRow) {
      row.add(line);
    } else {
      rows.add([line]);
    }
  }
  return rows.map((r) => (r..sort((a, b) => a.box.left.compareTo(b.box.left))).map((l) => l.text).join('   ')).join('\n');
}
