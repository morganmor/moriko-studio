// {{Name}} — Phaser game: boot → preload → play, scale FIT.
import Phaser from 'phaser';

class BootScene extends Phaser.Scene {
  constructor() { super('Boot'); }
  preload() { /* load assets here */ }
  create() { this.scene.start('Play'); }
}

class PlayScene extends Phaser.Scene {
  constructor() { super('Play'); }
  create() {
    this.add.text(400, 300, '{{Name}}', { color: '#fff', fontSize: '32px' }).setOrigin(0.5);
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  width: 800,
  height: 600,
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: [BootScene, PlayScene],
});
