// src/lsystem.js
import * as THREE from "three";

/* 發光葉子樹（手動控制亮度、多方向生長、每棵不同） */

const MAX_SEGMENTS = 30000;

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class LSystemPlant {
  constructor(userOpts = {}) {
    this.params = {
      genMax: 4,           // 世代：越大越高越多枝
      step: 0.9,           // 主幹每一節基本長度
      baseRadius: 0.22,    // 主幹底部半徑
      radiusDecay: 0.82,   // 層級上升變細
      angleDeg: 28,        // 側枝仰角基準
      branchPerLevel: 4,   // 每一節主幹長出幾根側枝
      leafClusterCount: 5, // 每根側枝末端幾片葉子
      leafSize: 1.4,
      animateSpeed: 1.0,
      decay: 0.7,
      glowFactor: 1.0,     // 🌟 你可調的發光倍率（Z/X 控制）
      seed: Math.floor(Math.random() * 1e9),
    };
    Object.assign(this.params, userOpts || {});

    this.ready = false;
    this.playing = true;

    // 幾何
    this.branchGeom = new THREE.CylinderGeometry(1.0, 1.0, 1.0, 10, 1, false);
    this.branchGeom.translate(0, 0.5, 0); // 底端 y=0, 頂端 y=1

    this.leafGeom = new THREE.PlaneGeometry(1.0, 0.8, 1, 1);
    const lp = this.leafGeom.attributes.position;
    for (let i = 0; i < lp.count; i++) {
      const x = lp.getX(i);
      const bulge = (1 - Math.abs(x)) * 0.15;
      lp.setZ(i, bulge);
    }
    this.leafGeom.computeVertexNormals();

    const barkColor = new THREE.Color(0x3a3024);
    this.branchMat = new THREE.MeshStandardMaterial({
      color: barkColor,
      roughness: 0.95,
      metalness: 0.0,
    });

    this.leafBaseColor = new THREE.Color(0x44ff88);
    this.leafMat = new THREE.MeshStandardMaterial({
      color: this.leafBaseColor.clone(),
      emissive: this.leafBaseColor.clone(),
      emissiveIntensity: 1.0 * this.params.glowFactor,
      roughness: 0.35,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });

    // 資料
    this.segments = []; // { start, end, level, radius }
    this.leaves = [];   // { pos, quat, scale, level }

    // 實例 Mesh
    this.branchMesh = null;
    this.leafMesh = null;

    this.group = new THREE.Group();
    if (userOpts.position) this.group.position.copy(userOpts.position);

    this._rebuild();
    this.update(0);
  }

  get object3d() { return this.group; }
  isReady() { return this.ready; }
  togglePlay() { this.playing = !this.playing; }

  // 留著給 main.js 呼叫（現在不做自動日夜）
  toggleDayNight() {
    // 不自動改亮度，什麼都不做或之後你要用再加
  }

  addGen(dg) {
    this.params.genMax = Math.max(0, this.params.genMax + dg);
    this._rebuild();
  }

  addAngle(da) {
    this.params.angleDeg = THREE.MathUtils.clamp(
      this.params.angleDeg + da,
      5,
      80
    );
    this._rebuild();
  }

  addDecay(dd) {
    this.params.decay = THREE.MathUtils.clamp(
      this.params.decay + dd,
      0.2,
      0.98
    );
  }

  // 🌟 發光倍率控制，全部由你控制，不自動變
  getGlowFactor() {
    return this.params.glowFactor ?? 1.0;
  }
  setGlowFactor(f) {
    this.params.glowFactor = THREE.MathUtils.clamp(f, 0.05, 5.0);
    this._updateLeafMaterial();
  }

  estimateHeight() {
    if (!this.segments.length) return 0;
    let minY = Infinity, maxY = -Infinity;
    for (const s of this.segments) {
      minY = Math.min(minY, s.start.y, s.end.y);
      maxY = Math.max(maxY, s.start.y, s.end.y);
    }
    return Math.max(0, maxY - minY);
  }

  update(_dt) {
    // 不做自動動畫（不自動變亮變暗）
    if (!this.ready || !this.playing) return;
  }

  /* ─────────── 建樹：主幹會微彎、左右延伸、側枝往四面八方 ─────────── */
  _buildStructure() {
    this.segments.length = 0;
    this.leaves.length = 0;

    const o = this.params;
    const rng = mulberry32(o.seed | 0);

    // 每棵樹自己的微調：不要長一模一樣
    const stepBase = o.step * (0.9 + rng() * 0.3);
    const radiusBase = o.baseRadius * (0.85 + rng() * 0.4);
    const angleDegBase = o.angleDeg + (rng() - 0.5) * 20; // ±10°
    const angleRadBase = THREE.MathUtils.degToRad(angleDegBase);
    const branchBase = Math.max(2, o.branchPerLevel + Math.floor((rng() - 0.5) * 3));
    const leafClusterBase = Math.max(3, o.leafClusterCount + Math.floor((rng() - 0.5) * 3));

    // 主幹起始點與方向（稍微有點傾斜）
    let pos = new THREE.Vector3(0, 0, 0);
    let trunkDir = new THREE.Vector3(
      (rng() - 0.5) * 0.3, // 一點點往左右
      1.0,
      (rng() - 0.5) * 0.3
    ).normalize();

    const maxYaw = 0.35;   // 每一節主幹可左右偏轉程度（rad）
    const maxPitch = 0.25; // 前後彎曲程度（rad）

    for (let level = 0; level <= o.genMax; level++) {
      const segLen = stepBase * (0.8 + 0.4 * rng());
      const start = pos.clone();
      const end = start.clone().addScaledVector(trunkDir, segLen);

      const radius =
        radiusBase *
        Math.pow(o.radiusDecay, level * (0.9 + rng() * 0.25));

      this.segments.push({ start, end, level, radius });

      // ── 側枝：從這一節主幹延伸出去 ──
      if (level >= 1) {
        // 建一個以主幹為軸的局部座標系，用來做左右方向
        const tmp = Math.abs(trunkDir.y) < 0.9
          ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(1, 0, 0);
        const side = new THREE.Vector3().crossVectors(trunkDir, tmp).normalize();
        const forward = new THREE.Vector3().crossVectors(side, trunkDir).normalize();

        const branchCount = Math.max(
          2,
          branchBase + Math.floor((rng() - 0.5) * 2)
        );

        const baseAngleY = rng() * Math.PI * 2;
        const tiltBase = angleRadBase * (0.8 + rng() * 0.4);

        for (let i = 0; i < branchCount; i++) {
          const azim =
            baseAngleY +
            (i / branchCount) * Math.PI * 2 +
            (rng() - 0.5) * 0.4;
          const tilt = tiltBase + (rng() - 0.5) * 0.4;

          // 水平分佈在 side/forward 平面上
          const horiz = new THREE.Vector3()
            .copy(side)
            .multiplyScalar(Math.cos(azim))
            .addScaledVector(forward, Math.sin(azim))
            .normalize();

          const dir = new THREE.Vector3()
            .copy(trunkDir)
            .multiplyScalar(Math.sin(tilt))
            .addScaledVector(horiz, Math.cos(tilt))
            .normalize();

          // 側枝起點：在這節主幹中段附近
          const startB = start.clone().lerp(end, 0.25 + 0.5 * rng());
          const lengthB = segLen * (0.6 + 0.6 * rng());
          const endB = startB.clone().addScaledVector(dir, lengthB);
          const radiusB = radius * (0.5 + 0.4 * rng());

          this.segments.push({
            start: startB,
            end: endB,
            level: level + 1,
            radius: radiusB,
          });

          // 葉子群：在側枝末端附近
          const leafN = Math.max(
            3,
            leafClusterBase + Math.floor((rng() - 0.5) * 3)
          );
          for (let j = 0; j < leafN; j++) {
            const offsetDir = dir.clone();
            const yawJitter = (rng() - 0.5) * 0.9;
            const pitchJitter = (rng() - 0.5) * 0.5;
            const qJit = new THREE.Quaternion()
              .setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawJitter)
              .multiply(
                new THREE.Quaternion().setFromAxisAngle(
                  new THREE.Vector3(1, 0, 0),
                  pitchJitter
                )
              );
            offsetDir.applyQuaternion(qJit).normalize();

            const q = new THREE.Quaternion().setFromUnitVectors(
              new THREE.Vector3(0, 0, 1),
              offsetDir
            );
            const droop = -0.6 + rng() * 0.8;
            q.multiply(
              new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(1, 0, 0),
                droop
              )
            );

            const leafPos = endB.clone().addScaledVector(offsetDir, 0.12 * rng());
            const size =
              o.leafSize *
              (0.8 + 0.7 * rng()) *
              THREE.MathUtils.clamp(1.2 - level * 0.08, 0.7, 1.5);

            this.leaves.push({
              pos: leafPos,
              quat: q,
              scale: new THREE.Vector3(size, size, 1),
              level,
              energy: 1,
            });
          }
        }
      }

      // 下一節主幹起點＆方向：讓主幹有點彎、往左右／前後偏
      pos.copy(end);
      const yaw = (rng() - 0.5) * maxYaw;
      const pitch = (rng() - 0.5) * maxPitch;
      const qYaw = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        yaw
      );
      const qPitch = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        pitch
      );
      trunkDir.applyQuaternion(qYaw).applyQuaternion(qPitch).normalize();
    }

    if (this.segments.length > MAX_SEGMENTS)
      this.segments.length = MAX_SEGMENTS;
    if (this.leaves.length > MAX_SEGMENTS)
      this.leaves.length = MAX_SEGMENTS;

    // 後備方案：如果意外沒有葉子，在最後一段主幹頂端補幾片
    if (this.leaves.length === 0 && this.segments.length > 0) {
      const last = this.segments[this.segments.length - 1];
      const center = last.end.clone();
      const dir = new THREE.Vector3()
        .subVectors(last.end, last.start)
        .normalize();
      for (let j = 0; j < 6; j++) {
        const q = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 0, 1),
          dir
        );
        const size = this.params.leafSize;
        this.leaves.push({
          pos: center.clone(),
          quat: q,
          scale: new THREE.Vector3(size, size, 1),
          level: last.level,
          energy: 1,
        });
      }
    }
  }

  _allocMeshes() {
    for (const m of [this.branchMesh, this.leafMesh]) {
      if (!m) continue;
      if (m.geometry) m.geometry.dispose();
      this.group.remove(m);
    }

    const nSeg = Math.max(1, this.segments.length);
    const nLeaf = Math.max(1, this.leaves.length);

    this.branchMesh = new THREE.InstancedMesh(
      this.branchGeom, this.branchMat, nSeg
    );
    this.branchMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.branchMesh);

    this.leafMesh = new THREE.InstancedMesh(
      this.leafGeom, this.leafMat, nLeaf
    );
    this.leafMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.leafMesh);

    this.ready = true;
  }

  _segMatrix(seg) {
    const dir = new THREE.Vector3()
      .subVectors(seg.end, seg.start)
      .normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      dir
    );
    const len = seg.start.distanceTo(seg.end);
    const pos = seg.start.clone();
    const m = new THREE.Matrix4();
    m.compose(pos, q, new THREE.Vector3(seg.radius, len, seg.radius));
    return m;
  }

  _applyInstances() {
    if (!this.ready) return;

    const segs = this.segments;
    const nSeg = segs.length;
    for (let i = 0; i < nSeg; i++) {
      this.branchMesh.setMatrixAt(i, this._segMatrix(segs[i]));
    }
    this.branchMesh.count = nSeg;
    this.branchMesh.instanceMatrix.needsUpdate = true;

    const leaves = this.leaves;
    const nLeaf = leaves.length;
    const m = new THREE.Matrix4();
    for (let i = 0; i < nLeaf; i++) {
      const lf = leaves[i];
      m.compose(lf.pos, lf.quat, lf.scale);
      this.leafMesh.setMatrixAt(i, m);
    }
    this.leafMesh.count = nLeaf;
    this.leafMesh.instanceMatrix.needsUpdate = true;
  }

  _updateLeafMaterial() {
    const glow = this.getGlowFactor();
    const baseEmissive = 1.0; // 基礎亮度
    this.leafMat.emissiveIntensity = baseEmissive * glow;
    this.leafMat.color.copy(this.leafBaseColor);
    this.leafMat.emissive.copy(this.leafBaseColor);
    this.leafMat.needsUpdate = true;
  }

  _rebuild() {
    this.ready = false;
    this._buildStructure();
    this._allocMeshes();
    this._applyInstances();
    this._updateLeafMaterial();
  }
}
