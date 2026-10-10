// {{Name}} — three-vite entry: loads the scene, spawns a test mesh, runs the loop.
import { createScene } from './core/scene.js';

const container = document.getElementById('app');
const { renderer, scene, camera, controls, dispose } = createScene(container);

const mesh = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x4488ff }),
);
scene.add(mesh);

let raf = 0;
function tick(t) {
  raf = requestAnimationFrame(tick);
  mesh.rotation.y = t / 1000;
  controls.update();
  renderer.render(scene, camera);
}
raf = requestAnimationFrame(tick);

window.addEventListener('beforeunload', () => {
  cancelAnimationFrame(raf);
  dispose();
});
