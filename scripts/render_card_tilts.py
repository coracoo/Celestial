"""Run with Blender --background --python to verify the saved editable card."""
from pathlib import Path
import bpy, sys

args = sys.argv[sys.argv.index('--')+1:]
project = Path(args[0]).resolve()
bpy.ops.wm.open_mainfile(filepath=str(project / 'card.blend'))
scene = bpy.context.scene
for name, frame in [('tilt-left', 1), ('tilt-right', 49)]:
    scene.frame_set(frame)
    scene.render.filepath = str(project / f'renders/{name}.png')
    bpy.ops.render.render(write_still=True)
print('BOTH_TILT_RENDERS_COMPLETE')
