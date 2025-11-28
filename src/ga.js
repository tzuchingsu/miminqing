// src/ga.js
// 유전 알고리즘 모듈: ThermoBug GA
// - Genome 정의
// - Phenotype 변환
// - Fitness / Selection / Crossover / Mutation / Next Generation

const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

export class GeneticAlgorithm {
  constructor({
    populationSize = 40,
    survivalRate = 0.4,
    mutationRate = 0.12,
    crossoverRate = 0.9,
    slotPatternIds = null,   // (옵션) 예전 슬롯 고정용 – 지금은 안 씀
    lockPatternSlots = false // 기본값: false (패턴은 진화 가능)
  } = {}) {
    this.populationSize = populationSize;
    this.survivalRate = survivalRate;
    this.mutationRate = mutationRate;
    this.crossoverRate = crossoverRate;
    this.slotPatternIds = slotPatternIds;
    this.lockPatternSlots = !!lockPatternSlots;

    /** @type {Array<Genome>} */
    this.population = [];
    /** @type {number[]} */
    this.fitness = [];
    /** @type {number} */
    this.generation = 0;

    // 내부 캐시
    this._sortedIndices = [];

    // ───────── Worldbuilding 連動常數 ─────────
    // 一開始：只有一種紋路（同族群）
    // 之後靠突變慢慢產生其他 patternId，再由適應度決定誰留下。
    this.initialPatternId = 0;        // Gen0 的紋路 (0~4 任選)
    this.SURVIVOR_PATTERN_ID = 2;     // 長期生存下來的「最適紋路」

    // 低溫環境 → 偏向冷色 & 深色
    this.PALETTE = {
      H_MIN: 200,   // 偏藍
      H_MAX: 260,
      V_MIN: 0.3,   // 不要太亮
      V_MAX: 0.8,
    };

    // 몸집 점수 (지금은 단순히 “적당한 몸집” 영역으로 사용)
    this.SIZE = {
      GOOD_MIN: 1.3,
      GOOD_MAX: 1.9,
    };

    // Movement good ranges (임의 설계)
    this.MOVE = {
      SPEED_GOOD_MIN: 0.85,
      SPEED_GOOD_MAX: 1.15,
      SHOWOFF_GOOD_MIN: 0.4,
      SHOWOFF_GOOD_MAX: 0.9,
    };

    // RD 패턴 메타 (Pattern Score용)
    // 값은 설계서 예시 범위 안에서 약간 정리
    this.PATTERN_META = [
      { spotCount: 32,  spotSize: 0.18, roughness: 0.18, type: 0.65 }, // patternId 0
      { spotCount: 24,  spotSize: 0.20, roughness: 0.10, type: 0.75 }, // 1
      { spotCount: 38,  spotSize: 0.22, roughness: 0.22, type: 0.55 }, // 2 ← 最終留下來的紋路(預設)
      { spotCount: 27,  spotSize: 0.25, roughness: 0.20, type: 0.45 }, // 3
      { spotCount: 100, spotSize: 0.12, roughness: 0.12, type: 0.40 }, // 4
    ];

    this.PATTERN_GOOD = {
      SPOT_MIN: 15,
      SPOT_MAX: 30,
      SIZE_MIN: 0.10,
      SIZE_MAX: 0.25,
    };
  }

  // ----------------------------
  // Genome 생성/초기화
  // ----------------------------

  _randomHue() { return Math.random() * 360; }               // 0~360
  _randomValue() { return Math.random(); }                   // 0~1
  _randomBodyScale() { return 1.0 + Math.random() * 2.0; }   // 1~3
  _randomBaseSpeed() { return 0.7 + Math.random() * 0.8; }   // 0.7~1.5
  _randomShowOff() { return Math.random(); }                 // 0~1

  // (참고용 – 지금은 초기 세대는 모두 initialPatternId로 강제)
  _randomPatternId(index) {
    if (this.slotPatternIds && this.slotPatternIds[index] != null) {
      return this.slotPatternIds[index];
    }
    return Math.floor(Math.random() * 5); // 0~4
  }

  /**
   * index 슬롯에 대한 랜덤 Genome 생성
   * Gen0: 全部同一個紋路 (this.initialPatternId)
   *       → 顏色 / 大小 / 速度等可以很雜，但圖案一樣。
   */
  createRandomGenome(index = 0) {
    return {
      hue: this._randomHue(),
      value: this._randomValue(),
      // 👇 Gen0: 同一紋路。之後靠 mutation 產生其他 patternId。
      patternId: this.initialPatternId,
      bodyScale: this._randomBodyScale(),
      baseSpeed: this._randomBaseSpeed(),
      showOff: this._randomShowOff(),
    };
  }

  /**
   * 초기 개체군 생성
   */
  initPopulation() {
    this.population = [];
    this.fitness = new Array(this.populationSize).fill(0);
    for (let i = 0; i < this.populationSize; i++) {
      this.population.push(this.createRandomGenome(i));
    }
    this.generation = 0;
    this._sortedIndices = [];
    return this.population;
  }

  getPopulation() {
    return this.population;
  }

  getGeneration() {
    return this.generation;
  }

  // ----------------------------
  // Phenotype 변환 (참고용)
  // ----------------------------

  toPhenotype(g) {
    const patternMeta = this.PATTERN_META[g.patternId] || this.PATTERN_META[0];
    return {
      bodyHue: g.hue,
      bodyValue: g.value,
      bodyScale: g.bodyScale,
      baseSpeed: g.baseSpeed,
      showOff: g.showOff,
      patternId: g.patternId,
      spotCount: patternMeta.spotCount,
      spotSize: patternMeta.spotSize,
      roughness: patternMeta.roughness,
      patternType: patternMeta.type,
    };
  }

  // ----------------------------
  // Score 함수들
  // ----------------------------

  /**
   * 3.1 Palette Score (색)
   * - 冷色(藍/青藍) & 深色 → 高分
   * - 暖色(紅/橘/黃/粉) → 會被扣分（高溫環境種族，難在低溫世界生存）
   */
  paletteScore(g) {
    const p = this.PALETTE;
    const hRaw = g.hue ?? 0;
    const h = ((hRaw % 360) + 360) % 360; // wrap 0~360
    const v = g.value ?? 0.5;

    let s = 0;

    // 冷色區獎勵
    if (h >= p.H_MIN && h <= p.H_MAX) {
      s += 0.6;
    }

    // 深色〜中等亮度
    if (v >= p.V_MIN && v <= p.V_MAX) {
      s += 0.4;
    }

    // 暖色區懲罰：紅/橘/黃/偏粉
    const isWarmHue =
      (h >= 20 && h <= 80) || // 黃橘
      (h >= 320 || h <= 10);  // 紅 & 偏粉

    if (isWarmHue) {
      s -= 0.35; // 低溫環境中，暖色族群不利
    }

    return clamp(s, 0, 1); // 0 ~ 1
  }

  /**
   * 3.2 Pattern Score (무늬)
   *
   * Concept:
   * - 早期世代：大家紋路差不多，只看「點數量＋大小」是否適合偽裝 / 生存。
   * - 世代增加：環境改變，開始強烈偏好某一種紋路 (SURVIVOR_PATTERN_ID)。
   *   → 其他 patternId 分數會慢慢下降，最後幾乎只剩一種紋路。
   */
  patternScore(g) {
    const meta = this.PATTERN_META[g.patternId] || this.PATTERN_META[0];
    const cfg = this.PATTERN_GOOD;

    // 基礎：spotCount / spotSize 是否在好範圍內
    let base = 0;
    if (meta.spotCount >= cfg.SPOT_MIN && meta.spotCount <= cfg.SPOT_MAX) base += 0.5;
    if (meta.spotSize >= cfg.SIZE_MIN && meta.spotSize <= cfg.SIZE_MAX) base += 0.5;

    // 目標紋路分數：只有 SURVIVOR_PATTERN_ID 可以拿滿 1
    const targetScore = (g.patternId === this.SURVIVOR_PATTERN_ID) ? 1.0 : 0.0;

    // phase: 當 generation<20 時，慢慢從「base」過渡到「target」
    const phase = clamp(this.generation / 20.0, 0, 1); // 0 → 1

    // 0世代：完全看 base
    // 20世代以後：幾乎只看 targetScore
    return (1 - phase) * base + phase * targetScore;
  }

  /**
   * 3.3 Size Score (몸집)
   * - bodyScale [1.3,1.9] → 1 점
   * - 아니면 0 점
   */
  sizeScore(g) {
    const s = g.bodyScale ?? 1.0;
    const cfg = this.SIZE;
    return (s >= cfg.GOOD_MIN && s <= cfg.GOOD_MAX) ? 1.0 : 0.0;
  }

  /**
   * MovementScore (baseSpeed, showOff)
   * - 적당한 속도 & 적당한 과시성에 가까울수록 점수 ↑ (0~1)
   */
  movementScore(g) {
    const m = this.MOVE;
    const sp = g.baseSpeed ?? 1.0;
    const sh = g.showOff ?? 0.5;

    const rangeScore = (v, min, max) => {
      const mid = 0.5 * (min + max);
      const half = 0.5 * (max - min);
      if (half <= 0) return 0;
      const d = Math.abs(v - mid) / half;
      const t = Math.min(d, 2.0);
      return Math.max(0, 1 - t * 0.5);
    };

    const sSpeed = rangeScore(sp, m.SPEED_GOOD_MIN, m.SPEED_GOOD_MAX);
    const sShow = rangeScore(sh, m.SHOWOFF_GOOD_MIN, m.SHOWOFF_GOOD_MAX);

    return 0.5 * (sSpeed + sShow); // 0~1
  }

  /**
   * 최종 Fitness
   * - 冷色 / 深色 / 目標紋路 比重比較高
   *   (색 + 무늬) 을 더 강하게 밀어줌
   */
  fitnessOf(g) {
    const p = this.paletteScore(g);
    const pat = this.patternScore(g);
    const sz = this.sizeScore(g);
    const mv = this.movementScore(g);

    const sum =
      1.5 * p +   // 색
      1.5 * pat + // 무늬
      1.0 * sz +  // 몸집
      1.0 * mv;   // 움직임

    const norm = 1.5 + 1.5 + 1.0 + 1.0; // = 5.0
    return sum / norm;
  }

  // ----------------------------
  // Evaluation & Selection
  // ----------------------------

  evaluatePopulation() {
    const n = this.populationSize;
    this.fitness = new Array(n);
    for (let i = 0; i < n; i++) {
      this.fitness[i] = this.fitnessOf(this.population[i]);
    }

    const indices = Array.from({ length: n }, (_, i) => i);
    indices.sort((a, b) => this.fitness[b] - this.fitness[a]);
    this._sortedIndices = indices;

    const survivorCount = Math.max(1, Math.floor(n * this.survivalRate));
    const survivors = indices.slice(0, survivorCount);
    const doomed = indices.slice(survivorCount);

    return { survivors, doomed };
  }

  /**
   * Tournament Selection (k=3)
   */
  _selectParentIndex() {
    const n = this.populationSize;
    let best = null;
    const k = 3;
    for (let i = 0; i < k; i++) {
      const idx = Math.floor(Math.random() * n);
      if (best === null || this.fitness[idx] > this.fitness[best]) {
        best = idx;
      }
    }
    return best ?? 0;
  }

  // ----------------------------
  // Crossover & Mutation
  // ----------------------------

  _crossover(g1, g2, childIdx) {
    const pick = (a, b) => (Math.random() < 0.5 ? a : b);
    const child = {
      hue:       pick(g1.hue,       g2.hue),
      value:     pick(g1.value,     g2.value),
      bodyScale: pick(g1.bodyScale, g2.bodyScale),
      baseSpeed: pick(g1.baseSpeed, g2.baseSpeed),
      showOff:   pick(g1.showOff,   g2.showOff),
      patternId: pick(g1.patternId, g2.patternId),
    };

    // 예전 슬롯 고정 옵션 – 지금은 기본적으로 쓰지 않는다.
    if (this.lockPatternSlots && this.slotPatternIds && this.slotPatternIds[childIdx] != null) {
      child.patternId = this.slotPatternIds[childIdx];
    } else {
      child.patternId = Math.max(0, Math.min(4, Math.round(child.patternId)));
    }

    return child;
  }

  _mutateFloat(v, min, max, strength = 0.15) {
    const span = max - min;
    const delta = (Math.random() * 2 - 1) * span * strength;
    let nv = v + delta;
    if (nv < min) nv = min;
    if (nv > max) nv = max;
    return nv;
  }

  _mutateInt(v, min, max) {
    if (Math.random() < 0.5) return v;
    const nv = v + (Math.random() < 0.5 ? -1 : 1);
    return Math.min(max, Math.max(min, nv));
  }

  mutate(genome, index) {
    if (Math.random() > this.mutationRate) return genome;

    const g = { ...genome };

    // Hue: 0~360 wrap
    if (Math.random() < 0.6) {
      const delta = (Math.random() * 2 - 1) * 40; // ±40°
      g.hue = (g.hue + delta + 360) % 360;
    }

    // Value: 0~1
    if (Math.random() < 0.6) {
      g.value = this._mutateFloat(g.value, 0, 1, 0.2);
    }

    // BodyScale: 1~3
    if (Math.random() < 0.5) {
      g.bodyScale = this._mutateFloat(g.bodyScale, 1.0, 3.0, 0.2);
    }

    // BaseSpeed: 0.7~1.5
    if (Math.random() < 0.5) {
      g.baseSpeed = this._mutateFloat(g.baseSpeed, 0.7, 1.5, 0.2);
    }

    // ShowOff: 0~1
    if (Math.random() < 0.5) {
      g.showOff = this._mutateFloat(g.showOff, 0.0, 1.0, 0.3);
    }

    // PatternId: 0~4
    // 👉 現在預設 lockPatternSlots = false → 可以突變成其他紋路
    if (!this.lockPatternSlots && Math.random() < 0.4) {
      g.patternId = this._mutateInt(g.patternId, 0, 4);
    } else if (this.lockPatternSlots && this.slotPatternIds && this.slotPatternIds[index] != null) {
      g.patternId = this.slotPatternIds[index];
    }

    return g;
  }

  // ----------------------------
  // Next Generation
  // ----------------------------

  nextGeneration(doomedIndices) {
    const n = this.populationSize;
    if (!this._sortedIndices || this._sortedIndices.length !== n) {
      this.evaluatePopulation();
    }

    const newPop = this.population.slice(); // survivors 그대로 복사

    for (const idx of doomedIndices) {
      const p1 = this.population[this._selectParentIndex()];
      const p2 = this.population[this._selectParentIndex()];

      let child;
      if (Math.random() < this.crossoverRate) {
        child = this._crossover(p1, p2, idx);
      } else {
        child = { ...(Math.random() < 0.5 ? p1 : p2) };
      }

      child = this.mutate(child, idx);
      newPop[idx] = child;
    }

    this.population = newPop;
    this.generation++;
    return this.population;
  }

  /**
   * 현재 세대에서 정렬된 인덱스 (fitness 내림차순)
   */
  getSortedIndices() {
    return this._sortedIndices.slice();
  }
}
