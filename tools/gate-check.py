import json, os, re, sys
OUT='/home/hatch/workspace/makefun/token-radar-01/out'
SNAP='/home/hatch/workspace/makefun/token-radar-01-kit/input/snapshot.json'
snap=json.load(open(SNAP)); protos={p['slug'] for p in snap['protocols']}
fails=[]
def check(name, ok, detail=''):
    print(('PASS' if ok else 'FAIL'), name, detail)
    if not ok: fails.append(name)
# 1 dashboard_files
d=os.path.join(OUT,'dashboard'); files=os.listdir(d)
check('dashboard_files: index.html', 'index.html' in files)
check('dashboard_files: css+js', any(f.endswith('.css') for f in files) and any(f.endswith('.js') for f in files))
tot=sum(os.path.getsize(os.path.join(d,f)) for f in files)
check('dashboard_files: <=400 files / 4MiB', len(files)<=400 and tot<=4*1024*1024, f'{len(files)} files, {tot} bytes')
bad=[]
for f in files:
    t=open(os.path.join(d,f), errors='ignore').read()
    for m in re.finditer(r'https?://[^\s"\'<>]+', t):
        bad.append(f'{f}: {m.group(0)[:60]}')
check('dashboard_files: no http(s) URLs in dashboard files', not bad, '; '.join(bad[:5]) or 'none found')
# 2 board_file
board=json.load(open(os.path.join(OUT,'board.json')))
rows=board['rows'] if isinstance(board, dict) else board
check('board_file: 100-4000 rows', 100<=len(rows)<=4000, f'{len(rows)} rows')
ok=True; det=''
for r in rows:
    if r['slug'] not in protos: ok=False; det=f"unknown slug {r['slug']}"; break
    if not r['name'] or not isinstance(r['implied_value_usd'], int) or r['implied_value_usd']<=0 or r['implied_value_usd']>10**14: ok=False; det=f"bad row {r['slug']}"; break
    if not isinstance(r['farm_steps'], list): ok=False; det=f"no farm_steps {r['slug']}"; break
check('board_file: slugs/names/implied valid', ok, det)
check('board_file: <=8MiB', os.path.getsize(os.path.join(OUT,'board.json'))<=8*1024*1024)
# 3 sorted_by_value
ranks=sorted(r['rank'] for r in rows)
check('sorted_by_value: ranks 1..N', ranks==list(range(1,len(rows)+1)))
vals=[r['implied_value_usd'] for r in rows]
check('sorted_by_value: non-increasing', all(vals[i]>=vals[i+1] for i in range(len(vals)-1)))
check('sorted_by_value: not all equal', len(set(vals))>1, f'{len(set(vals))} distinct values')
# 4 coverage
missing=[w for w in snap['watchlist'] if w not in {r['slug'] for r in rows}]
check('coverage: all 40 watchlist slugs', not missing, f'missing {missing}' if missing else '40/40')
# 5 farm_steps
bad2=[]
for r in rows:
    s=r['farm_steps']
    if not (3<=len(s)<=12): bad2.append(r['slug']); break
    for x in s:
        if not (20<=len(x.strip())<=600): bad2.append((r['slug'],len(x))); break
check('farm_steps: 3-12 steps, 20-600 chars', not bad2, str(bad2[:3]))
# 6 screenshots
shots=sorted(os.listdir(os.path.join(OUT,'screenshots')))
check('screenshots: 3-4 images', 3<=len(shots)<=4, str(shots))
from PIL import Image
ok=True; det=[]
for f in shots:
    p=os.path.join(OUT,'screenshots',f); sz=os.path.getsize(p)
    im=Image.open(p); w,h=im.size
    if sz>524288: ok=False; det.append(f'{f} {sz}B')
    if max(w,h)>1440 or min(w,h)<800: ok=False; det.append(f'{f} {w}x{h}')
check('screenshots: <=512KiB, long<=1440, short>=800', ok, '; '.join(det) or 'all ok')
# 7 dossier
doss=open(os.path.join(OUT,'dossier.json'),'rb').read()
check('dossier_matches: <=1.5MiB', len(doss)<=1572864, f'{len(doss)} bytes')
print()
print('RESULT:', 'ALL 7 GATES PASS' if not fails else f'FAILURES: {fails}')
sys.exit(0 if not fails else 1)
