"""
Tambahkan daftar SEMUA SKU Code per barcode ke data/sku-*.json (field "codes").

Kenapa perlu: 1 barcode bisa punya beberapa SKU Code di Product Hierarchy
(kode lama yang Delisted, kode pengganti, dst). Stock distributor dicatat per
SKU Code, jadi kalau cuma 1 kode (pcode / Parent SKU) yang dicek, stock yang
tercatat di kode lain terbaca "kosong".

Sumber: file "Product Hierarchy" ULI (sheet "ID PH", header di baris ke-4).
Sebuah SKU Code masuk ke barcode-nya sendiri ("Product (PC)"). Kalau barcode itu
tidak ada di daftar SKU wajib, baru dicocokkan lewat "Parent Product Barcode".
Aturan ini mencegah 1 kode terhitung di 2 barcode (data induk ada yang bersilang,
mis. Molto Pink <-> Blue) yang bikin stock terhitung dobel.

Jalankan SETELAH build_data.py (build_data.py menulis ulang sku-*.json tanpa "codes"):
    python3 scripts/build_sku_codes.py "/path/ke/20260825_Product Hierarchy.xlsx"
Membutuhkan: pip install openpyxl
"""
import json
import sys
from collections import defaultdict
from pathlib import Path
import openpyxl

DATA_DIR = Path("data")
SKU_FILES = ['sku-haba-dt', 'sku-lmt-spm', 'sku-local-minis']

COL_SKU_CODE, COL_DESC, COL_ISI, COL_EAN_PC = 0, 1, 3, 5
COL_STATUS, COL_OVERALL_STATUS, COL_PARENT_BARCODE = 20, 53, 75
HEADER_ROWS = 4

# Urutan tampil: yang masih aktif dulu, delisted paling bawah.
STATUS_ORDER = {'Active': 0, 'Active No Production': 1}


def s(v):
    return str(v).strip() if v is not None else ''


def build_barcode_to_codes(hierarchy_path, known_barcodes):
    wb = openpyxl.load_workbook(hierarchy_path, data_only=True, read_only=True)
    rows = list(wb['ID PH'].iter_rows(values_only=True))[HEADER_ROWS:]
    by_barcode = defaultdict(dict)
    for r in rows:
        code = s(r[COL_SKU_CODE])
        if not code:
            continue
        try:
            isi = int(r[COL_ISI]) if r[COL_ISI] is not None else None
        except (ValueError, TypeError):
            isi = None
        entry = {
            'code': code,
            'name': s(r[COL_DESC]),
            'isi': isi,
            'status': s(r[COL_OVERALL_STATUS]) or s(r[COL_STATUS]),
        }
        own, parent = s(r[COL_EAN_PC]), s(r[COL_PARENT_BARCODE])
        target = own if own in known_barcodes else parent
        if target:
            by_barcode[target][code] = entry
    return by_barcode


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    known = {it['barcode'] for name in SKU_FILES
             for it in json.loads((DATA_DIR / f'{name}.json').read_text())}
    by_barcode = build_barcode_to_codes(sys.argv[1], known)
    for name in SKU_FILES:
        path = DATA_DIR / f'{name}.json'
        items = json.loads(path.read_text())
        missing = 0
        for it in items:
            codes = sorted(by_barcode.get(it['barcode'], {}).values(),
                           key=lambda c: (STATUS_ORDER.get(c['status'], 9), c['code']))
            if not codes:
                missing += 1
            it['codes'] = codes
        path.write_text(json.dumps(items, ensure_ascii=False, indent=2))
        print(f"{name}.json: {len(items)} SKU, {missing} barcode tanpa SKU Code di hierarchy")


if __name__ == '__main__':
    main()
