import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';

import '../../../../core/widgets/format.dart';
import '../../domain/stats.dart';

/// Grafico a ciambella della spesa per categoria (massimo 6 spicchi + "Altro", calcolati dal server).
class CategoryDonut extends StatefulWidget {
  const CategoryDonut({super.key, required this.slices});

  final List<CategorySlice> slices;

  @override
  State<CategoryDonut> createState() => _CategoryDonutState();
}

class _CategoryDonutState extends State<CategoryDonut> {
  int? _touched;

  /// Tonalità derivate dal colore primario, "Altro" sempre in grigio.
  List<Color> _palette(ColorScheme s) => [
        s.primary,
        s.tertiary,
        s.secondary,
        s.primary.withValues(alpha: 0.55),
        s.tertiary.withValues(alpha: 0.55),
        s.secondary.withValues(alpha: 0.55),
      ];

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final palette = _palette(scheme);
    final slices = widget.slices;
    Color colorOf(int i) => slices[i].category == 'Altro' ? scheme.outlineVariant : palette[i % palette.length];
    final selected = _touched != null && _touched! < slices.length ? slices[_touched!] : null;
    final total = slices.fold<double>(0, (s, c) => s + c.spentEur);

    return Column(children: [
      SizedBox(
        height: 200,
        child: Stack(alignment: Alignment.center, children: [
          PieChart(
            PieChartData(
              centerSpaceRadius: 62,
              sectionsSpace: 2,
              pieTouchData: PieTouchData(
                touchCallback: (event, response) {
                  if (!event.isInterestedForInteractions) return;
                  setState(() => _touched = response?.touchedSection?.touchedSectionIndex);
                },
              ),
              sections: [
                for (var i = 0; i < slices.length; i++)
                  PieChartSectionData(
                    value: slices[i].spentEur,
                    color: colorOf(i),
                    radius: i == _touched ? 34 : 28,
                    showTitle: false,
                  ),
              ],
            ),
          ),
          Column(mainAxisSize: MainAxisSize.min, children: [
            Text(selected?.category ?? 'Totale', style: Theme.of(context).textTheme.bodySmall),
            Text(euro(selected?.spentEur ?? total), style: Theme.of(context).textTheme.titleMedium),
          ]),
        ]),
      ),
      const SizedBox(height: 12),
      for (var i = 0; i < slices.length; i++)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 3),
          child: Row(children: [
            Container(width: 12, height: 12, decoration: BoxDecoration(color: colorOf(i), shape: BoxShape.circle)),
            const SizedBox(width: 8),
            Expanded(child: Text(slices[i].category)),
            Text('${euro(slices[i].spentEur)} · ${percent(slices[i].sharePct)}'),
          ]),
        ),
    ]);
  }
}
