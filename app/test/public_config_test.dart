import 'package:flutter_test/flutter_test.dart';
import 'package:spesa_smart/features/settings/public_config.dart';

void main() {
  test('confronto tra versioni', () {
    expect(compareVersions('0.1.0', '0.2.0'), -1);
    expect(compareVersions('1.10.0', '1.9.9'), 1);
    expect(compareVersions('1.2.3', '1.2.3'), 0);
  });

  test('parametri pubblici dal pannello', () {
    final c = PublicConfig.fromJson({
      'values': {'app.maintenanceMessage': ' Manutenzione stasera ', 'app.minSupportedVersion': '9.0.0', 'geo.maxRadiusKm': 40},
    });
    expect(c.maintenanceMessage, 'Manutenzione stasera');
    expect(c.updateRequired, isTrue);
    expect(c.maxRadiusKm, 40);
    expect(PublicConfig.fromJson({}).updateRequired, isFalse);
  });
}
