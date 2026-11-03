import 'package:flutter_test/flutter_test.dart';
import 'package:spesa_smart/core/storage/local_store.dart';

PendingOp op(String kind, String itemId, [Map<String, dynamic> body = const {}]) =>
    PendingOp(kind: kind, listId: 'l1', idempotencyKey: '$kind-$itemId-${body.hashCode}', itemId: itemId, body: body);

void main() {
  test('più modifiche dello stesso articolo diventano una', () {
    final q = PendingOp.compact([
      op('update', 'i1', {'quantity': 2}),
      op('update', 'i1', {'checked': true}),
      op('update', 'i1', {'quantity': 3}),
    ]);
    expect(q, hasLength(1));
    expect(q.single.body, {'quantity': 3, 'checked': true});
  });

  test('la quantità di un articolo non ancora inviato entra nella sua aggiunta', () {
    final q = PendingOp.compact([
      op('add', 'tmp-a', {'raw': 'latte'}),
      op('update', 'tmp-a', {'quantity': 4}),
    ]);
    expect(q.single.kind, 'add');
    expect(q.single.body, {'raw': 'latte', 'quantity': 4});
  });

  test('rimuovere un articolo mai inviato annulla l\'aggiunta', () {
    final q = PendingOp.compact([
      op('add', 'tmp-a', {'raw': 'latte'}),
      op('add', 'tmp-b', {'raw': 'pane'}),
      op('remove', 'tmp-a'),
    ]);
    expect(q.map((o) => o.itemId), ['tmp-b']);
  });

  test('rimuovere un articolo inviato annulla le sue modifiche in coda', () {
    final q = PendingOp.compact([op('update', 'i1', {'quantity': 2}), op('remove', 'i1')]);
    expect(q.single.kind, 'remove');
  });

  test('le code salvate prima della v1.3 sono aggiunte', () {
    final o = PendingOp.fromJson({'listId': 'l1', 'idempotencyKey': 'k', 'body': {'raw': 'uova'}});
    expect(o.kind, 'add');
    expect(PendingOp.fromJson(o.toJson()).body, {'raw': 'uova'});
  });
}
