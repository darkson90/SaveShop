import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'list_controller.dart';

/// Aperta da un link d'invito (https://…/i/CODICE o saveshop:///i/CODICE): entra nella lista condivisa.
class JoinInviteScreen extends ConsumerStatefulWidget {
  const JoinInviteScreen({super.key, required this.code});

  final String code;

  @override
  ConsumerState<JoinInviteScreen> createState() => _JoinInviteScreenState();
}

class _JoinInviteScreenState extends ConsumerState<JoinInviteScreen> {
  String? _error;

  @override
  void initState() {
    super.initState();
    Future.microtask(_join);
  }

  Future<void> _join() async {
    setState(() => _error = null);
    try {
      await ref.read(listControllerProvider.notifier).join(widget.code);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Sei entrato nella lista condivisa')));
      context.go('/lista');
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Invito')),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: _error == null
              ? Column(mainAxisSize: MainAxisSize.min, children: [
                  const CircularProgressIndicator(),
                  const SizedBox(height: 16),
                  Text('Entro nella lista con il codice ${widget.code}…'),
                ])
              : Column(mainAxisSize: MainAxisSize.min, children: [
                  Icon(Icons.link_off, size: 48, color: Theme.of(context).colorScheme.error),
                  const SizedBox(height: 12),
                  Text(_error!, textAlign: TextAlign.center),
                  const SizedBox(height: 16),
                  FilledButton.tonal(onPressed: _join, child: const Text('Riprova')),
                  TextButton(onPressed: () => context.go('/lista'), child: const Text('Vai alla mia lista')),
                ]),
        ),
      ),
    );
  }
}
