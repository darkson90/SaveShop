import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../domain/models.dart';
import '../list_controller.dart';

/// Campo di inserimento sempre a fuoco: Invio aggiunge e lascia il cursore nel campo.
/// Accetta la sintassi rapida ("2 latte", "latte x2", "1,5 kg mele"), interpretata dal server.
class QuickAddField extends ConsumerStatefulWidget {
  const QuickAddField({super.key});

  @override
  ConsumerState<QuickAddField> createState() => _QuickAddFieldState();
}

class _QuickAddFieldState extends ConsumerState<QuickAddField> {
  final _controller = TextEditingController();
  final _focus = FocusNode();
  Timer? _debounce;
  List<ProductRef> _suggestions = const [];
  int _request = 0;

  @override
  void dispose() {
    _debounce?.cancel();
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _onChanged(String text) {
    _debounce?.cancel();
    // Debounce di 150 ms dal 2° carattere, come da specifica.
    if (text.trim().length < 2) {
      setState(() => _suggestions = const []);
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 150), () async {
      final id = ++_request;
      try {
        final words = text.trim().split(RegExp(r'\s+'));
        // La ricerca usa il testo senza quantità iniziale ("2 lat" -> "lat").
        final query = RegExp(r'^\d').hasMatch(words.first) && words.length > 1 ? words.skip(1).join(' ') : text.trim();
        final items = await ref.read(listRepositoryProvider).suggest(query);
        if (mounted && id == _request) setState(() => _suggestions = items);
      } catch (_) {
        // Senza rete niente suggerimenti: l'inserimento libero funziona comunque.
      }
    });
  }

  Future<void> _submit([String? override]) async {
    final text = (override ?? _controller.text).trim();
    if (text.isEmpty) return;
    _clear();
    await _guard(() => ref.read(listControllerProvider.notifier).addRaw(text));
  }

  Future<void> _pick(ProductRef p) async {
    final text = _controller.text.trim();
    final qty = RegExp(r'^(\d+(?:[.,]\d+)?)\s').firstMatch('$text ')?.group(1);
    _clear();
    // Con una quantità digitata ("3 mozz") inviamo il testo, il server applica parser + abbinamento.
    await _guard(() => qty != null
        ? ref.read(listControllerProvider.notifier).addRaw('$qty ${p.name}')
        : ref.read(listControllerProvider.notifier).addProduct(p.id, p.name));
  }

  void _clear() {
    _controller.clear();
    setState(() => _suggestions = const []);
    _focus.requestFocus();
  }

  Future<void> _guard(Future<void> Function() fn) async {
    try {
      await fn();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      TextField(
        controller: _controller,
        focusNode: _focus,
        autofocus: true,
        textInputAction: TextInputAction.done,
        textCapitalization: TextCapitalization.sentences,
        decoration: InputDecoration(
          hintText: 'Aggiungi prodotto, es. "2 latte"',
          prefixIcon: const Icon(Icons.add),
          suffixIcon: IconButton(icon: const Icon(Icons.keyboard_return), onPressed: _submit, tooltip: 'Aggiungi'),
        ),
        onChanged: _onChanged,
        onSubmitted: (_) => _submit(),
      ),
      if (_suggestions.isNotEmpty)
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Wrap(spacing: 8, runSpacing: 4, children: [
            for (final s in _suggestions)
              ActionChip(
                avatar: const Icon(Icons.search, size: 16),
                label: Text(s.name),
                onPressed: () => _pick(s),
              ),
          ]),
        ),
    ]);
  }
}
