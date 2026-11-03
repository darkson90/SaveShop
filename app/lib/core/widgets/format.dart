import 'package:intl/intl.dart';

final _euro = NumberFormat.currency(locale: 'it_IT', symbol: '€', decimalDigits: 2);
final _num = NumberFormat.decimalPattern('it_IT');

String euro(num value) => _euro.format(value);
String percent(num value) => '${_num.format(value)}%';
String km(num value) => '${_num.format(value)} km';

/// "2 pz", "1,5 kg": i pezzi interi senza decimali.
String quantity(num q, String unit) {
  final text = q == q.roundToDouble() ? q.toInt().toString() : _num.format(q);
  return '$text $unit';
}
