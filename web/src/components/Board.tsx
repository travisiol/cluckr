"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import {
  GOLD,
  GOLD_RGB,
  RED,
  RED_RGB,
  addStudioLights,
  approach,
  createRenderer,
  createStudioEnvironment,
  disposeScene,
  glowPlane,
  observeSize,
  radialGlowTexture,
  runLoop,
  slate,
  supportsWebGL,
} from "@/lib/three/studio";
import { makeBone, makeChicken, makeCloche, makePlate } from "@/lib/three/props";
import { BoardFallback } from "@/components/BoardFallback";
import { useMounted } from "@/components/ConnectButton";

export type CellView = "covered" | "pending" | "chicken" | "bone" | "dim" | "gold";

export interface BoardProps {
  cells: CellView[];
  /** true while a lift may be placed. */
  interactive: boolean;
  /** "busted" flashes red, "cashed" flashes gold; anything else is quiet. */
  mood: "quiet" | "busted" | "cashed";
  onPick: (cell: number) => void;
  className?: string;
}

const GRID = 5;
const SPACING = 1.34;
const LIFT_OPEN = 1.55;

interface CellRig {
  cell: number;
  root: THREE.Group;
  cloche: THREE.Group;
  clocheMaterial: THREE.MeshPhysicalMaterial;
  hit: THREE.Mesh;
  item: THREE.Group | null;
  itemMaterial: THREE.MeshPhysicalMaterial | null;
  view: CellView;
  lift: number;
  tilt: number;
  back: number;
  opacity: number;
  itemScale: number;
  hover: number;
  shown: CellView | null;
}

let webglSupport: boolean | null = null;
function webgl(): boolean {
  if (webglSupport === null) webglSupport = supportsWebGL();
  return webglSupport;
}

/**
 * The table: 25 chrome cloches on plates under a warm spotlight. Hover
 * lifts one a touch, a lift in flight bobs, a settled lift swings the
 * cloche up and back to show the roast or the bone underneath. The
 * board is the page; the HUD floats over it.
 */
export function Board({ cells, interactive, mood, onPick, className = "" }: BoardProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mounted = useMounted();
  const supported = mounted ? webgl() : null;
  const latest = useRef({ cells, interactive, mood, onPick });
  const [hovered, setHovered] = useState<number | null>(null);
  useEffect(() => {
    latest.current = { cells, interactive, mood, onPick };
  }, [cells, interactive, mood, onPick]);

  useEffect(() => {
    if (!supported) return;
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const renderer = createRenderer(canvas);
    const environment = createStudioEnvironment(renderer);
    const scene = new THREE.Scene();
    scene.environment = environment;

    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
    const CAM = new THREE.Vector3(0, 8.1, 7.6);
    const LOOK = new THREE.Vector3(0, 0.15, -0.35);
    camera.position.copy(CAM);
    camera.lookAt(LOOK);

    const { flash } = addStudioLights(scene);

    // The table top and its pool of light.
    const top = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), slate());
    top.rotation.x = -Math.PI / 2;
    top.position.y = -0.001;
    scene.add(top);
    const pool = glowPlane(radialGlowTexture("255, 196, 120", 0.34), 13);
    pool.rotation.x = -Math.PI / 2;
    pool.position.y = 0.002;
    scene.add(pool);

    // A thin brass line framing the grid, so the 5×5 reads as one object.
    const frameW = GRID * SPACING + 0.5;
    const border = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(frameW, frameW)),
      new THREE.LineBasicMaterial({ color: GOLD, transparent: true, opacity: 0.22 }),
    );
    border.rotation.x = -Math.PI / 2;
    border.position.y = 0.004;
    scene.add(border);

    const rigs: CellRig[] = [];
    const hits: THREE.Mesh[] = [];
    const hitGeometry = new THREE.CylinderGeometry(0.62, 0.62, 0.9, 16);
    const hitMaterial = new THREE.MeshBasicMaterial({ visible: false });
    for (let cell = 0; cell < GRID * GRID; cell++) {
      const row = Math.floor(cell / GRID);
      const col = cell % GRID;
      const root = new THREE.Group();
      root.position.set((col - 2) * SPACING, 0, (row - 2) * SPACING);
      scene.add(root);
      root.add(makePlate());
      const { group: cloche, material } = makeCloche();
      root.add(cloche);
      const hit = new THREE.Mesh(hitGeometry, hitMaterial);
      hit.position.y = 0.45;
      hit.userData.cell = cell;
      root.add(hit);
      hits.push(hit);
      rigs.push({
        cell,
        root,
        cloche,
        clocheMaterial: material,
        hit,
        item: null,
        itemMaterial: null,
        view: "covered",
        lift: 0,
        tilt: 0,
        back: 0,
        opacity: 1,
        itemScale: 0,
        hover: 0,
        shown: null,
      });
    }

    // Pointer: hover and pick by raycast against invisible cylinders.
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2(-10, -10);
    let hoverCell: number | null = null;
    let pointerInside = false;
    const updatePointer = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1));
      pointerInside = true;
    };
    const pickAt = (): number | null => {
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(hits, false)[0];
      return hit ? (hit.object.userData.cell as number) : null;
    };
    const onMove = (event: PointerEvent) => {
      updatePointer(event);
      const cell = pickAt();
      const { cells: views, interactive: canPick } = latest.current;
      const next = cell !== null && canPick && views[cell] === "covered" ? cell : null;
      if (next !== hoverCell) {
        hoverCell = next;
        setHovered(next);
        canvas.style.cursor = next === null ? "default" : "pointer";
      }
    };
    const onLeave = () => {
      pointerInside = false;
      pointer.set(-10, -10);
      if (hoverCell !== null) {
        hoverCell = null;
        setHovered(null);
        canvas.style.cursor = "default";
      }
    };
    const onClick = (event: PointerEvent) => {
      updatePointer(event);
      const cell = pickAt();
      const { cells: views, interactive: canPick, onPick: pick } = latest.current;
      if (cell !== null && canPick && views[cell] === "covered") pick(cell);
    };
    canvas.addEventListener("pointermove", onMove, { passive: true });
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("pointerdown", onClick);

    // Keep the whole grid in frame on narrow screens by backing the camera off.
    let zoom = 1;
    const stopResize = observeSize(host, (w, h) => {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      zoom = Math.min(2.2, Math.max(1, 1.45 / (w / h)));
      camera.position.copy(CAM).multiplyScalar(zoom);
      camera.lookAt(LOOK);
    });

    const goldTexture = radialGlowTexture(GOLD_RGB, 0.9);
    const redTexture = radialGlowTexture(RED_RGB, 0.9);
    let moodShown: BoardProps["mood"] = "quiet";
    let moodAt = 0;
    let shake = 0;

    const reveal = (rig: CellRig, view: CellView) => {
      if (rig.item) {
        rig.root.remove(rig.item);
        disposeGroup(rig.item);
        rig.item = null;
        rig.itemMaterial = null;
      }
      if (view === "chicken" || view === "gold") {
        const chicken = makeChicken();
        chicken.scale.setScalar(0.001);
        chicken.userData.size = 1.3;
        rig.root.add(chicken);
        rig.item = chicken;
        const halo = glowPlane(goldTexture, 1.6);
        halo.rotation.x = -Math.PI / 2;
        halo.position.y = 0.06;
        chicken.add(halo);
      } else if (view === "bone") {
        const { group, material } = makeBone();
        group.scale.setScalar(0.001);
        group.userData.size = 1.25;
        rig.root.add(group);
        rig.item = group;
        rig.itemMaterial = material;
        const halo = glowPlane(redTexture, 1.8);
        halo.rotation.x = -Math.PI / 2;
        halo.position.y = 0.06;
        group.add(halo);
      }
      rig.itemScale = 0.001;
    };

    const stop = runLoop((t, dt) => {
      const { cells: views, mood: currentMood } = latest.current;
      const speed = reduce ? 40 : 1;

      if (currentMood !== moodShown) {
        moodShown = currentMood;
        moodAt = t;
        if (currentMood === "busted") shake = 1;
      }
      const since = t - moodAt;
      if (moodShown === "busted") {
        flash.color.set(RED);
        flash.intensity = Math.max(0, 70 * Math.exp(-since * 1.6)) + 6 * (0.5 + 0.5 * Math.sin(t * 2.2));
      } else if (moodShown === "cashed") {
        flash.color.set(GOLD);
        flash.intensity = Math.max(0, 55 * Math.exp(-since * 1.3)) + 8 * (0.5 + 0.5 * Math.sin(t * 1.6));
      } else {
        flash.intensity = approach(flash.intensity, 0, dt, 6);
      }

      for (const rig of rigs) {
        const view = views[rig.cell] ?? "covered";
        if (view !== rig.shown) {
          if (view === "chicken" || view === "bone" || view === "gold") reveal(rig, view);
          else if (rig.item) {
            rig.root.remove(rig.item);
            disposeGroup(rig.item);
            rig.item = null;
            rig.itemMaterial = null;
          }
          rig.shown = view;
          rig.view = view;
          if (view === "bone") flash.position.copy(rig.root.position).setY(1.2);
        }
        const hovering = hoverCell === rig.cell && view === "covered";
        rig.hover = approach(rig.hover, hovering ? 1 : 0, dt, 14 * speed);

        let targetLift = 0;
        let targetTilt = 0;
        let targetBack = 0;
        let targetOpacity = 1;
        let bob = 0;
        if (view === "pending") {
          targetLift = 0.28;
          bob = Math.sin(t * 11) * 0.05;
          targetTilt = Math.sin(t * 7) * 0.05;
        } else if (view === "chicken" || view === "bone" || view === "gold") {
          targetLift = LIFT_OPEN + (view === "gold" ? 0.1 + Math.sin(t * 2 + rig.cell) * 0.04 : 0);
          targetTilt = -0.8;
          targetBack = -1.0;
          targetOpacity = 0.14;
        } else if (view === "dim") {
          targetOpacity = 0.75;
        }
        const s = view === "pending" ? 10 : 5.5;
        rig.lift = approach(rig.lift, targetLift, dt, s * speed);
        rig.tilt = approach(rig.tilt, targetTilt, dt, s * speed);
        rig.back = approach(rig.back, targetBack, dt, s * speed);
        rig.opacity = approach(rig.opacity, targetOpacity, dt, 4 * speed);

        rig.cloche.position.y = rig.lift + bob + rig.hover * 0.14;
        rig.cloche.position.z = rig.back;
        rig.cloche.rotation.x = rig.tilt;
        rig.cloche.rotation.z = view === "pending" ? Math.sin(t * 9) * 0.03 : 0;
        rig.clocheMaterial.opacity = rig.opacity;
        rig.clocheMaterial.envMapIntensity = view === "dim" ? 0.45 : 1.3 + rig.hover * 0.5;
        rig.clocheMaterial.emissive.set(GOLD);
        rig.clocheMaterial.emissiveIntensity = rig.hover * 0.06;

        if (rig.item) {
          rig.itemScale = approach(rig.itemScale, 1, dt, 7 * speed);
          const overshoot = 1 + Math.sin(Math.min(1, rig.itemScale) * Math.PI) * 0.12;
          rig.item.scale.setScalar(rig.itemScale * overshoot * ((rig.item.userData.size as number) ?? 1));
          if (view === "gold") rig.item.position.y = 0.05 + Math.abs(Math.sin(t * 3 + rig.cell)) * 0.08;
          if (rig.itemMaterial) {
            rig.itemMaterial.emissiveIntensity = moodShown === "busted" ? 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(t * 6)) : 0;
          }
        }
      }

      // Camera: a slow breath, a nudge toward the pointer, a jolt on a bone.
      const sway = reduce ? 0 : 1;
      const px = pointerInside ? pointer.x : 0;
      const py = pointerInside ? pointer.y : 0;
      shake = approach(shake, 0, dt, 5);
      const jolt = shake * Math.sin(t * 60) * 0.08;
      camera.position.set(
        (CAM.x + Math.sin(t * 0.35) * 0.18 * sway + px * 0.5 + jolt) * zoom,
        (CAM.y + Math.sin(t * 0.5) * 0.08 * sway + py * 0.25) * zoom,
        (CAM.z + jolt * 0.5) * zoom,
      );
      camera.lookAt(LOOK.x, LOOK.y + shake * 0.03 * Math.sin(t * 43), LOOK.z);

      renderer.render(scene, camera);
    });

    return () => {
      stop();
      stopResize();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointerdown", onClick);
      for (const rig of rigs) if (rig.item) disposeGroup(rig.item);
      disposeScene(scene);
      environment.dispose();
      goldTexture.dispose();
      redTexture.dispose();
      renderer.dispose();
    };
  }, [supported]);

  if (supported === false) {
    return <BoardFallback cells={cells} interactive={interactive} onPick={onPick} className={className} />;
  }

  return (
    <div ref={hostRef} className={`relative h-full w-full ${className}`} aria-label="The table">
      <canvas ref={canvasRef} className="block h-full w-full" aria-hidden="true" />
      {/* Keyboard access to the same 25 cloches, kept off-screen for pointer users. */}
      <div className="sr-only">
        <BoardFallback cells={cells} interactive={interactive} onPick={onPick} />
      </div>
      {hovered !== null && interactive ? (
        <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full border border-edge bg-void/70 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-2">
          Lift {"ABCDE"[Math.floor(hovered / 5)]}
          {(hovered % 5) + 1}
        </div>
      ) : null}
    </div>
  );
}

function disposeGroup(group: THREE.Group): void {
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      // Geometries are shared across props; only the halo planes own theirs.
      const material = o.material as THREE.Material;
      if ((material as THREE.MeshBasicMaterial).map) o.geometry.dispose();
      material.dispose();
    }
  });
}
