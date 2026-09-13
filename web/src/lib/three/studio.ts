import * as THREE from "three";

/*
  three.js plumbing for the table. Everything is painted at runtime: no
  texture, model or HDR file is loaded, ever.
*/

export const GOLD = 0xf4b942;
export const GOLD_RGB = "244, 185, 66";
export const RED = 0xff3b30;
export const RED_RGB = "255, 59, 48";
export const COLD = 0x5a7cff;

export function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  return renderer;
}

/**
 * A rotisserie studio for chrome: a black room, one big warm softbox
 * overhead and to the left, a long thin white strip for the specular line
 * that runs across every dome, a warm floor bounce so the undersides are
 * not black, and one cold kicker from behind so the metal has a second,
 * bluish edge and reads as chrome rather than as a warm blob.
 */
export function createStudioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(30, 30, 30), new THREE.MeshBasicMaterial({ color: 0x050403, side: THREE.BackSide })));

  const panel = (w: number, h: number, color: number, intensity: number, x: number, y: number, z: number) => {
    const material = new THREE.MeshBasicMaterial();
    material.color.set(color).multiplyScalar(intensity);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
    mesh.position.set(x, y, z);
    mesh.lookAt(0, 0, 0);
    scene.add(mesh);
  };

  panel(8, 5, 0xfff1dc, 6.5, -5, 8, 3); // key softbox, warm, top-left-front
  panel(14, 0.5, 0xffffff, 7, 0, 9, -1); // thin strip overhead → the specular line
  panel(5, 8, 0xffe6c0, 2.2, 8, 3, 2); // fill, right
  panel(12, 8, 0xfff4e6, 0.8, 0, 2, 11); // broad soft panel behind the camera: fronts read as metal
  panel(12, 4, 0xffb060, 0.7, 0, -7, 3); // warm floor bounce
  panel(9, 2, GOLD, 4, -2, -3, -7); // gold rim, low and behind
  panel(6, 6, COLD, 1.4, 7, 4, -7); // cold kicker, far right-back

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0.04);
  pmrem.dispose();
  disposeScene(scene);
  return target.texture;
}

/** Soft radial glow as a texture, for light pools on the table. */
export function radialGlowTexture(rgb: string, alpha: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, `rgba(${rgb}, ${alpha})`);
    gradient.addColorStop(0.4, `rgba(${rgb}, ${alpha * 0.35})`);
    gradient.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function glowPlane(texture: THREE.Texture, size: number): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
}

export function chrome(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xe2e0da,
    metalness: 1,
    roughness: 0.16,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
    envMapIntensity: 1.3,
    transparent: true,
  });
}

export function ceramic(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xf1e9d8,
    metalness: 0,
    roughness: 0.32,
    clearcoat: 0.8,
    clearcoatRoughness: 0.15,
    envMapIntensity: 0.8,
  });
}

export function roast(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xb9631c,
    metalness: 0,
    roughness: 0.36,
    clearcoat: 0.95,
    clearcoatRoughness: 0.22,
    envMapIntensity: 1.0,
    sheen: 0.4,
    sheenColor: new THREE.Color(0xffb15c),
  });
}

export function ivory(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xefe6d2,
    metalness: 0,
    roughness: 0.55,
    clearcoat: 0.2,
    envMapIntensity: 0.7,
    emissive: new THREE.Color(RED),
    emissiveIntensity: 0,
  });
}

export function slate(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0x14110e, metalness: 0.05, roughness: 0.92 });
}

/** Key / fill / rim lights over the table. */
export function addStudioLights(scene: THREE.Scene): { flash: THREE.PointLight } {
  scene.add(new THREE.AmbientLight(0xfff0dd, 0.16));
  const key = new THREE.SpotLight(0xffe9c8, 260, 30, Math.PI / 5, 0.55, 1.6);
  key.position.set(-2.5, 9, 4);
  key.target.position.set(0, 0, 0);
  scene.add(key, key.target);
  const fill = new THREE.PointLight(0xffd9a8, 24, 22, 1.8);
  fill.position.set(5, 4, 4);
  scene.add(fill);
  const cold = new THREE.PointLight(COLD, 14, 18, 1.8);
  cold.position.set(3, 3, -6);
  scene.add(cold);
  // The one light that changes: red on a bone, gold on a cash-out.
  const flash = new THREE.PointLight(RED, 0, 9, 1.4);
  flash.position.set(0, 1.4, 0);
  scene.add(flash);
  return { flash };
}

/** Calls `cb` now and on every size change of `el`. */
export function observeSize(el: HTMLElement, cb: (width: number, height: number) => void): () => void {
  const emit = () => {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) cb(rect.width, rect.height);
  };
  const observer = new ResizeObserver(emit);
  observer.observe(el);
  emit();
  window.addEventListener("resize", emit);
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", emit);
  };
}

/** requestAnimationFrame loop that pauses while the tab is hidden. */
export function runLoop(render: (time: number, dt: number) => void): () => void {
  let raf = 0;
  let running = false;
  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    render(now / 1000, dt);
    raf = requestAnimationFrame(frame);
  };
  const sync = () => {
    const should = !document.hidden;
    if (should && !running) {
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    } else if (!should && running) {
      running = false;
      cancelAnimationFrame(raf);
    }
  };
  document.addEventListener("visibilitychange", sync);
  sync();
  return () => {
    document.removeEventListener("visibilitychange", sync);
    cancelAnimationFrame(raf);
    running = false;
  };
}

export function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

export function disposeScene(scene: THREE.Scene): void {
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        const map = (material as THREE.MeshBasicMaterial).map;
        if (map) map.dispose();
        material.dispose();
      }
    }
  });
}

/** Critically damped approach: smooth, no overshoot, frame-rate independent. */
export function approach(current: number, target: number, dt: number, speed: number): number {
  return current + (target - current) * (1 - Math.exp(-speed * dt));
}
