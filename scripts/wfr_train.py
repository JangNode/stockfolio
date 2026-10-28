"""[임시 연구 — 병합 금지] 연구 WFR(시도 248~250) 2단계: 연 1회(매년 첫 거래일) 확장 윈도우 LightGBM 재학습 → 다음 해 전체 예측.
입력: scripts/wfr-export.ts가 만든 .wfr/ (특성·라벨·메타). 출력: .wfr/scores_<변형>.f32(예측 연도 행만 값, 나머지 NaN), importance.json, train_log.json.
사전 등록: docs/research/walkforward-ranker-prereg.md. 하이퍼파라미터는 meta.json(lib/walkforwardRankerConfig.ts의 WFR_LGB_PARAMS)을 그대로 쓰며 튜닝·특성 선택·조기 종료는 하지 않는다.
SMOKE=1이면 아주 작은 부분집합으로 한 번만 적합해 환경(설치·실행)만 확인한다(성과·점수 출력 없음).
"""
import json
import os
import sys
import time

import lightgbm as lgb
import numpy as np

D = os.environ.get("WFR_DIR", ".wfr")
meta = json.load(open(os.path.join(D, "meta.json")))
n, nf = meta["nRows"], meta["nFeat"]
X = np.fromfile(os.path.join(D, "X.f32"), dtype=np.float32).reshape(n, nf)
day = np.fromfile(os.path.join(D, "dayIdx.i32"), dtype=np.int32)
Y = {h: np.fromfile(os.path.join(D, f"y{h}.f32"), dtype=np.float32) for h in meta["horizons"]}
p = dict(meta["params"])
nround = int(p.pop("n_estimators"))
print(f"lightgbm {lgb.__version__} | numpy {np.__version__} | python {sys.version.split()[0]}", flush=True)
print(f"행 {n}, 특성 {nf}, 변형 {len(meta['variants'])}개, 라운드 {nround}, 파라미터 {json.dumps(p, ensure_ascii=False)}", flush=True)

if os.environ.get("SMOKE") == "1":
    # 환경 점검: 앞쪽 3만 행으로 10라운드만 적합(성과 지표 없음)
    m = np.isfinite(Y[20][:30000])
    ds = lgb.Dataset(X[:30000][m], label=Y[20][:30000][m])
    b = lgb.train({**p, "verbosity": -1}, ds, num_boost_round=10)
    print(f"SMOKE 적합 성공: 트리 {b.num_trees()}개", flush=True)
    sys.exit(0)

c0 = meta["c0"]
first = {int(k): v for k, v in meta["firstIdxOfYear"].items()}
pred_years = [y for y in meta["years"] if y >= meta["firstPredYear"]]
dates = meta["dates"]
# 날짜별 연속 구간(행은 날짜 순으로 정렬돼 있다)
change = np.flatnonzero(np.diff(day)) + 1
starts = np.concatenate([[0], change]); ends = np.concatenate([change, [n]])

def shuffled(y, seed):
    """각 날짜 횡단면 안에서 라벨을 무작위로 섞는다(값이 있는 행끼리만)."""
    rng = np.random.default_rng(seed)
    out = y.copy()
    for a, b in zip(starts, ends):
        idx = np.flatnonzero(np.isfinite(y[a:b])) + a
        if len(idx) > 1:
            out[idx] = y[rng.permutation(idx)]
    return out

log = []
imp_all = {}
for v in meta["variants"]:
    t0 = time.time()
    H = v["horizon"]
    cols = list(range(nf if v["flow"] else meta["nPrice"]))
    y = Y[H]
    if v["shuffle"]:
        y = shuffled(y, meta["shuffleSeed"])
    scores = np.full(n, np.nan, dtype=np.float32)
    imp = np.zeros(len(cols), dtype=np.float64)
    for yr in pred_years:
        f0 = first[yr]
        last_train = f0 - H - 2  # 퍼지: 예측 연도 직전 H+1 거래일 제외
        tr = (day >= c0) & (day <= last_train) & np.isfinite(y)
        pr = (day >= f0) & (day < first.get(yr + 1, 10**9))
        if tr.sum() < 1000 or pr.sum() == 0:
            continue
        params = {**p, "seed": int(v["seed"]), "verbosity": -1}
        ds = lgb.Dataset(X[tr][:, cols], label=y[tr])
        b = lgb.train(params, ds, num_boost_round=nround)
        scores[pr] = b.predict(X[pr][:, cols]).astype(np.float32)
        g = b.feature_importance(importance_type="gain")
        imp += g
        log.append({"variant": v["name"], "year": yr, "nTrain": int(tr.sum()), "trainFrom": dates[int(day[tr].min())], "trainTo": dates[int(day[tr].max())], "nPred": int(pr.sum()), "predFrom": dates[f0]})
    scores.tofile(os.path.join(D, f"scores_{v['name']}.f32"))
    names = [meta["featureNames"][c] for c in cols]
    imp_all[v["name"]] = {nm: float(x) for nm, x in zip(names, imp)}
    print(f"변형 {v['name']} (H={H}, 수급 {'사용' if v['flow'] else '미사용'}, 시드 {v['seed']}, 셔플 {v['shuffle']}) 완료 {time.time() - t0:.0f}초, 예측 행 {int(np.isfinite(scores).sum())}", flush=True)
json.dump(imp_all, open(os.path.join(D, "importance.json"), "w"), ensure_ascii=False)
json.dump(log, open(os.path.join(D, "train_log.json"), "w"), ensure_ascii=False)
print("학습·예측 완료", flush=True)
