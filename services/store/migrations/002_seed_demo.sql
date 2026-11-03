-- Dati dimostrativi: insegne fittizie e punti vendita nell'area del Cadore.
INSERT INTO chains (id, name) VALUES
  ('0190a000-0000-7000-8000-00000000c001', 'SuperRisparmio'),
  ('0190a000-0000-7000-8000-00000000c002', 'MercatoPiù'),
  ('0190a000-0000-7000-8000-00000000c003', 'Discount Alpino'),
  ('0190a000-0000-7000-8000-00000000c004', 'Bottega Fresca');

INSERT INTO stores (id, chain_id, name, address, location, external_ref) VALUES
  ('0190a000-0000-7000-8000-00000000a001', '0190a000-0000-7000-8000-00000000c001', 'SuperRisparmio Pieve',     'Via Roma 12, Pieve di Cadore',  ST_GeogFromText('POINT(12.373 46.427)'), 'superrisparmio-pieve'),
  ('0190a000-0000-7000-8000-00000000a002', '0190a000-0000-7000-8000-00000000c001', 'SuperRisparmio Cortina',   'Via Cesare Battisti 5, Cortina', ST_GeogFromText('POINT(12.137 46.538)'), 'superrisparmio-cortina'),
  ('0190a000-0000-7000-8000-00000000a003', '0190a000-0000-7000-8000-00000000c002', 'MercatoPiù Calalzo',       'Via Stazione 3, Calalzo',       ST_GeogFromText('POINT(12.380 46.449)'), 'mercatopiu-calalzo'),
  ('0190a000-0000-7000-8000-00000000a004', '0190a000-0000-7000-8000-00000000c002', 'MercatoPiù Valle',         'Via Nazionale 40, Valle di Cadore', ST_GeogFromText('POINT(12.330 46.418)'), 'mercatopiu-valle'),
  ('0190a000-0000-7000-8000-00000000a005', '0190a000-0000-7000-8000-00000000c003', 'Discount Alpino Borca',    'Via Trieste 8, Borca di Cadore', ST_GeogFromText('POINT(12.218 46.437)'), 'discount-borca'),
  ('0190a000-0000-7000-8000-00000000a006', '0190a000-0000-7000-8000-00000000c004', 'Bottega Fresca Vodo',      'Piazza 1, Vodo di Cadore',       ST_GeogFromText('POINT(12.245 46.419)'), 'bottega-vodo');
