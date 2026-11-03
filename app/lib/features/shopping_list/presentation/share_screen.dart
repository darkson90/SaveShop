import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../../app/providers.dart';
import '../../../core/widgets/async_view.dart';
import 'list_controller.dart';

/// Condivisione della lista corrente: membri, codice d'invito, uscita.
class ShareScreen extends ConsumerStatefulWidget {
  const ShareScreen({super.key});

  @override
  ConsumerState<ShareScreen> createState() => _ShareScreenState();
}

class _ShareScreenState extends ConsumerState<ShareScreen> {
  ({String code, DateTime expiresAt})? _invite;
  bool _busy = false;

  Future<void> _createInvite(String listId) async {
    setState(() => _busy = true);
    try {
      final invite = await ref.read(listRepositoryProvider).createInvite(listId);
      setState(() => _invite = invite);
    } catch (e) {
      _snack(e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _remove(String listId, String userId, String label) async {
    final ok = await _confirm('Rimuovere $label?', 'Non vedrà più la lista e non potrà modificarla.');
    if (!ok) return;
    try {
      await ref.read(listRepositoryProvider).removeMember(listId, userId);
      await ref.read(listControllerProvider.notifier).reload();
    } catch (e) {
      _snack(e.toString());
    }
  }

  Future<void> _leave() async {
    final ok = await _confirm('Uscire dalla lista?', 'Potrai rientrare solo con un nuovo codice.');
    if (!ok) return;
    final me = await ref.read(currentUserIdProvider.future);
    if (me == null) return;
    try {
      await ref.read(listControllerProvider.notifier).leave(me);
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      _snack(e.toString());
    }
  }

  Future<bool> _confirm(String title, String body) async =>
      await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text(title),
          content: Text(body),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Annulla')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Conferma')),
          ],
        ),
      ) ??
      false;

  void _snack(String msg) {
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    final list = ref.watch(listControllerProvider);
    final me = ref.watch(currentUserIdProvider).valueOrNull;
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(title: const Text('Condividi la lista')),
      body: AsyncView(
        value: list,
        data: (l) => ListView(padding: const EdgeInsets.all(16), children: [
          Text(l.name, style: theme.textTheme.titleLarge),
          const SizedBox(height: 4),
          Text('Chi è nella lista vede le modifiche degli altri in tempo reale.', style: theme.textTheme.bodySmall),
          const SizedBox(height: 16),
          if (l.isOwner) ...[
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: _invite == null
                    ? Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                        const Text('Invita fino a 4 persone con un codice valido 48 ore.'),
                        const SizedBox(height: 12),
                        FilledButton.icon(
                          onPressed: _busy ? null : () => _createInvite(l.id),
                          icon: const Icon(Icons.person_add_alt),
                          label: const Text('Genera codice d\'invito'),
                        ),
                      ])
                    : Column(children: [
                        SelectableText(
                          _invite!.code,
                          style: theme.textTheme.displaySmall?.copyWith(letterSpacing: 6, fontWeight: FontWeight.w600),
                        ),
                        Text('Valido fino al ${DateFormat('d MMM, HH:mm', 'it_IT').format(_invite!.expiresAt.toLocal())}'),
                        const SizedBox(height: 12),
                        Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                          OutlinedButton.icon(
                            onPressed: () {
                              Clipboard.setData(ClipboardData(text: _invite!.code));
                              _snack('Codice copiato');
                            },
                            icon: const Icon(Icons.copy),
                            label: const Text('Copia'),
                          ),
                          const SizedBox(width: 8),
                          TextButton(onPressed: _busy ? null : () => _createInvite(l.id), child: const Text('Nuovo codice')),
                        ]),
                      ]),
              ),
            ),
            const SizedBox(height: 16),
          ],
          Text('Membri (${l.members.length})', style: theme.textTheme.titleSmall),
          for (final m in l.members)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: CircleAvatar(child: Text(m.label.isEmpty ? '?' : m.label[0].toUpperCase())),
              title: Text(m.userId == me ? '${m.label} (tu)' : m.label),
              subtitle: Text(m.isOwner ? 'Ha creato la lista' : 'Può modificare'),
              trailing: l.isOwner && !m.isOwner
                  ? IconButton(icon: const Icon(Icons.person_remove_outlined), onPressed: () => _remove(l.id, m.userId, m.label))
                  : null,
            ),
          if (!l.isOwner) ...[
            const SizedBox(height: 16),
            OutlinedButton.icon(onPressed: _leave, icon: const Icon(Icons.logout), label: const Text('Esci dalla lista')),
          ],
        ]),
      ),
    );
  }
}

/// Dialogo "Hai un codice?": entra in una lista condivisa da un'altra persona.
Future<void> showJoinDialog(BuildContext context, WidgetRef ref) async {
  final controller = TextEditingController();
  final code = await showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('Entra in una lista condivisa'),
      content: TextField(
        controller: controller,
        autofocus: true,
        textCapitalization: TextCapitalization.characters,
        maxLength: 6,
        decoration: const InputDecoration(labelText: 'Codice d\'invito', hintText: 'es. A7UQWS'),
        onSubmitted: (v) => Navigator.pop(ctx, v),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Annulla')),
        FilledButton(onPressed: () => Navigator.pop(ctx, controller.text), child: const Text('Entra')),
      ],
    ),
  );
  // Il controller non viene eliminato qui: il campo resta montato durante l'animazione di chiusura.
  if (code == null || code.trim().length < 6) return;
  try {
    await ref.read(listControllerProvider.notifier).join(code);
    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Sei entrato nella lista condivisa')));
  } catch (e) {
    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
  }
}
