/**
 * F5.1 — moriko-gl: minimal WebGL2 3D helper (~10 KB, zero dependencies).
 * Renderer, perspective camera, orbit controls, box/sphere/plane primitives,
 * Lambert/unlit materials, rAF loop with resize + DPR cap 2.
 * Exposes window.MORIKO_GL.
 */
(function (global) {
  'use strict';

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function mat4Identity() { return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); }
  function mat4Multiply(a, b) {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] =
          a[0 * 4 + r] * b[c * 4 + 0] + a[1 * 4 + r] * b[c * 4 + 1] +
          a[2 * 4 + r] * b[c * 4 + 2] + a[3 * 4 + r] * b[c * 4 + 3];
      }
    }
    return out;
  }
  function mat4Perspective(fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY / 2);
    const nf = 1 / (near - far);
    const out = new Float32Array(16);
    out[0] = f / aspect; out[5] = f; out[10] = (far + near) * nf;
    out[11] = -1; out[14] = 2 * far * near * nf;
    return out;
  }
  function mat4LookAt(eye, center, up) {
    let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
    let len = Math.hypot(zx, zy, zz) || 1;
    zx /= len; zy /= len; zz /= len;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    len = Math.hypot(xx, xy, xz) || 1;
    xx /= len; xy /= len; xz /= len;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    const out = new Float32Array(16);
    out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
    out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
    out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
    out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    out[15] = 1;
    return out;
  }
  function mat4Translate(m, x, y, z) {
    const out = new Float32Array(m);
    out[12] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[13] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[14] = m[2] * x + m[6] * y + m[10] * z + m[14];
    out[15] = m[3] * x + m[7] * y + m[11] * z + m[15];
    return out;
  }
  function mat4RotateY(m, rad) {
    const s = Math.sin(rad), c = Math.cos(rad);
    const rot = new Float32Array([c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]);
    return mat4Multiply(m, rot);
  }

  const VERT = `#version 300 es
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec3 aNormal;
  uniform mat4 uProj, uView, uModel;
  out vec3 vNormal; out vec3 vWorld;
  void main() {
    vec4 world = uModel * vec4(aPos, 1.0);
    vWorld = world.xyz;
    vNormal = mat3(uModel) * aNormal;
    gl_Position = uProj * uView * world;
  }`;
  const FRAG_LAMBERT = `#version 300 es
  precision highp float;
  in vec3 vNormal; in vec3 vWorld;
  uniform vec3 uColor; uniform vec3 uLightDir;
  out vec4 frag;
  void main() {
    float d = max(dot(normalize(vNormal), normalize(uLightDir)), 0.0);
    vec3 c = uColor * (0.25 + 0.75 * d);
    frag = vec4(c, 1.0);
  }`;
  const FRAG_UNLIT = `#version 300 es
  precision highp float;
  uniform vec3 uColor;
  out vec4 frag;
  void main() { frag = vec4(uColor, 1.0); }`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('shader: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  function boxGeometry() {
    const p = 0.5;
    const faces = [
      { n: [0,0,1], v: [[-p,-p,p],[p,-p,p],[p,p,p],[-p,p,p]] },
      { n: [0,0,-1], v: [[p,-p,-p],[-p,-p,-p],[-p,p,-p],[p,p,-p]] },
      { n: [1,0,0], v: [[p,-p,p],[p,-p,-p],[p,p,-p],[p,p,p]] },
      { n: [-1,0,0], v: [[-p,-p,-p],[-p,-p,p],[-p,p,p],[-p,p,-p]] },
      { n: [0,1,0], v: [[-p,p,p],[p,p,p],[p,p,-p],[-p,p,-p]] },
      { n: [0,-1,0], v: [[-p,-p,-p],[p,-p,-p],[p,-p,p],[-p,-p,p]] },
    ];
    const pos = [], nor = [], idx = [];
    faces.forEach((f, i) => {
      f.v.forEach((v) => { pos.push(v[0], v[1], v[2]); nor.push(f.n[0], f.n[1], f.n[2]); });
      idx.push(i*4, i*4+1, i*4+2, i*4, i*4+2, i*4+3);
    });
    return { pos: new Float32Array(pos), nor: new Float32Array(nor), idx: new Uint16Array(idx) };
  }

  function sphereGeometry(latBands, lonBands) {
    latBands = latBands || 12; lonBands = lonBands || 16;
    const pos = [], nor = [], idx = [];
    for (let lat = 0; lat <= latBands; lat++) {
      const theta = (lat * Math.PI) / latBands;
      const st = Math.sin(theta), ct = Math.cos(theta);
      for (let lon = 0; lon <= lonBands; lon++) {
        const phi = (lon * 2 * Math.PI) / lonBands;
        const x = st * Math.cos(phi), y = ct, z = st * Math.sin(phi);
        pos.push(x, y, z); nor.push(x, y, z);
      }
    }
    for (let lat = 0; lat < latBands; lat++) {
      for (let lon = 0; lon < lonBands; lon++) {
        const a = lat * (lonBands + 1) + lon;
        idx.push(a, a + lonBands + 1, a + 1, a + 1, a + lonBands + 1, a + lonBands + 2);
      }
    }
    return { pos: new Float32Array(pos), nor: new Float32Array(nor), idx: new Uint16Array(idx) };
  }

  function planeGeometry(segments) {
    segments = segments || 1;
    const pos = [], nor = [], idx = [];
    for (let y = 0; y <= segments; y++) {
      for (let x = 0; x <= segments; x++) {
        const u = (x / segments) * 2 - 1;
        const v = (y / segments) * 2 - 1;
        pos.push(u, 0, v); nor.push(0, 1, 0);
      }
    }
    for (let y = 0; y < segments; y++) {
      for (let x = 0; x < segments; x++) {
        const a = y * (segments + 1) + x;
        idx.push(a, a + segments + 1, a + 1, a + 1, a + segments + 1, a + segments + 2);
      }
    }
    return { pos: new Float32Array(pos), nor: new Float32Array(nor), idx: new Uint16Array(idx) };
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  function Renderer(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    this.prog = gl.createProgram();
    this.unlitProg = gl.createProgram();
    this.meshes = [];
    this.clear = [0.07, 0.08, 0.1, 1];
    this._buildProgram(this.prog, FRAG_LAMBERT);
    this._buildProgram(this.unlitProg, FRAG_UNLIT);
    this._projLoc = {}; this._viewLoc = {}; this._modelLoc = {}; this._colorLoc = {}; this._lightLoc = {};
    this._cacheUniforms(this.prog, 'l');
    this._cacheUniforms(this.unlitProg, 'u');
    this.resize();
  }
  Renderer.prototype._buildProgram = function (prog, fragSrc) {
    const gl = this.gl;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(prog));
    }
  };
  Renderer.prototype._cacheUniforms = function (prog, prefix) {
    const gl = this.gl;
    this['_' + prefix + 'Proj'] = gl.getUniformLocation(prog, 'uProj');
    this['_' + prefix + 'View'] = gl.getUniformLocation(prog, 'uView');
    this['_' + prefix + 'Model'] = gl.getUniformLocation(prog, 'uModel');
    this['_' + prefix + 'Color'] = gl.getUniformLocation(prog, 'uColor');
    this['_' + prefix + 'Light'] = gl.getUniformLocation(prog, 'uLightDir');
  };
  Renderer.prototype.resize = function () {
    const dpr = clamp(global.devicePixelRatio || 1, 1, 2);
    const w = Math.floor(this.gl.canvas.clientWidth * dpr);
    const h = Math.floor(this.gl.canvas.clientHeight * dpr);
    if (this.gl.canvas.width !== w || this.gl.canvas.height !== h) {
      this.gl.canvas.width = w; this.gl.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  };
  Renderer.prototype.addMesh = function (geometry, options) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, geometry.pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const nbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, nbo);
    gl.bufferData(gl.ARRAY_BUFFER, geometry.nor, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    const mesh = {
      vao, ibo, count: geometry.idx.length,
      color: hexToRgb((options && options.color) || '#4488ff'),
      unlit: !!(options && options.unlit),
      model: mat4Identity(),
      rotateY: 0,
      translate: [0, 0, 0],
      scale: 1,
    };
    this.meshes.push(mesh);
    return mesh;
  };
  Renderer.prototype.box = function (opts) { return this.addMesh(boxGeometry(), opts); };
  Renderer.prototype.sphere = function (opts) { return this.addMesh(sphereGeometry(), opts); };
  Renderer.prototype.plane = function (opts) { return this.addMesh(planeGeometry(), opts); };
  Renderer.prototype.render = function (camera) {
    const gl = this.gl;
    gl.clearColor(this.clear[0], this.clear[1], this.clear[2], this.clear[3]);
    gl.enable(gl.DEPTH_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const proj = mat4Perspective(camera.fov, this.gl.canvas.width / this.gl.canvas.height, 0.1, 100);
    const view = mat4LookAt(camera.eye, [0, 0, 0], [0, 1, 0]);
    for (const mesh of this.meshes) {
      let model = mat4Translate(mat4Identity(), mesh.translate[0], mesh.translate[1], mesh.translate[2]);
      if (mesh.rotateY) model = mat4RotateY(model, mesh.rotateY);
      const prog = mesh.unlit ? this.unlitProg : this.prog;
      const p = mesh.unlit ? 'u' : 'l';
      gl.useProgram(prog);
      gl.uniformMatrix4fv(this['_' + p + 'Proj'], false, proj);
      gl.uniformMatrix4fv(this['_' + p + 'View'], false, view);
      gl.uniformMatrix4fv(this['_' + p + 'Model'], false, model);
      gl.uniform3fv(this['_' + p + 'Color'], mesh.color);
      if (this['_' + p + 'Light']) gl.uniform3fv(this['_' + p + 'Light'], [0.5, 0.9, 0.6]);
      gl.bindVertexArray(mesh.vao);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
    }
    gl.bindVertexArray(null);
  };

  function OrbitCamera(distance) {
    this.distance = distance || 5;
    this.theta = 0.8;
    this.phi = 1.1;
    this.fov = (60 * Math.PI) / 180;
    this.fov = (60 * Math.PI) / 180;
    this.dragging = false;
    this.lastX = 0; this.lastY = 0;
    Object.defineProperty(this, 'eye', {
      get: function () {
        const r = this.distance;
        return [
          r * Math.sin(this.phi) * Math.cos(this.theta),
          r * Math.cos(this.phi),
          r * Math.sin(this.phi) * Math.sin(this.theta),
        ];
      },
    });
  }
  OrbitCamera.prototype.attach = function (canvas) {
    const self = this;
    canvas.addEventListener('pointerdown', (e) => { self.dragging = true; self.lastX = e.clientX; self.lastY = e.clientY; });
    global.addEventListener('pointerup', () => { self.dragging = false; });
    global.addEventListener('pointermove', (e) => {
      if (!self.dragging) return;
      self.theta -= (e.clientX - self.lastX) * 0.005;
      self.phi = clamp(self.phi - (e.clientY - self.lastY) * 0.005, 0.05, Math.PI - 0.05);
      self.lastX = e.clientX; self.lastY = e.clientY;
    });
  };

  function loop(renderer, camera, onUpdate) {
    let raf = 0;
    let running = true;
    document.addEventListener('visibilitychange', () => { running = !document.hidden; });
    function frame(t) {
      raf = requestAnimationFrame(frame);
      if (!running) return;
      renderer.resize();
      if (onUpdate) onUpdate(t / 1000);
      renderer.render(camera);
    }
    raf = requestAnimationFrame(frame);
    return function stop() { cancelAnimationFrame(raf); };
  }

  global.MORIKO_GL = { Renderer, OrbitCamera, loop, mat4: { identity: mat4Identity, multiply: mat4Multiply, perspective: mat4Perspective, lookAt: mat4LookAt, translate: mat4Translate, rotateY: mat4RotateY } };
})(typeof window !== 'undefined' ? window : globalThis);
