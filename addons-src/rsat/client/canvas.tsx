/**
 * RSA/T canvas (area utama) — port 1:1 dari design/split/rsat-panel-canvas.html.
 * `.view > .view-in`: view overview → Base camp, view board → Quest board,
 * view tree → Skill tree, view lain → canvas-hint (placeholder berikutnya).
 */
import Basecamp from './basecamp.tsx';
import QuestBoard from './questboard.tsx';
import SkillTree from './skilltree.tsx';
import Interlinked from './interlinked.tsx';
import LiveFeed from './livefeed.tsx';
import Inventory from './inventory.tsx';
import Options from './options.tsx';
import CreateAgent from './createagent.tsx';

const VIEWS = ['Base camp', 'Quest board', 'Skill tree', 'Interlinked', 'Live feed', 'Inventory', 'Options', 'Create agent'];

export default function Canvas({ view, onOpen }: {
  view: string;
  onOpen: (id: string) => void;
}) {
  const live = ['overview', 'board', 'tree', 'interlinked', 'activity', 'files', 'settings', 'create'].includes(view);
  return (
    <div className="view">
      <div className={live ? 'view-in live' : 'view-in'}>
        {view === 'overview' ? (
          <Basecamp onOpen={onOpen} />
        ) : view === 'board' ? (
          <QuestBoard onOpen={onOpen} />
        ) : view === 'tree' ? (
          <SkillTree onOpen={onOpen} />
        ) : view === 'interlinked' ? (
          <Interlinked onOpen={onOpen} />
        ) : view === 'activity' ? (
          <LiveFeed />
        ) : view === 'files' ? (
          <Inventory onOpen={onOpen} />
        ) : view === 'settings' ? (
          <Options />
        ) : view === 'create' ? (
          <CreateAgent />
        ) : (
          <div className="canvas-hint">
            <div className="eyebrow">Main canvas</div>
            <b>Component area</b>
            <p>
              Ini adalah wadah tengah tempat semua komponen RSA/T dirender — Base camp, Quest board,
              Skill tree, Live feed, Inventory, dan Options.
            </p>
            <div className="chips">
              {VIEWS.map((v) => (
                <span className="chip" key={v}>
                  {v}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
