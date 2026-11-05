"""Matplotlib backend that renders figures inline in the browser console.

Selected via ``MPLBACKEND=module://ide_mpl``. ``plt.show()`` and
``fig.show()`` emit PNG images; figures left open at the end of a run are
shown automatically (like a notebook).
"""

from matplotlib._pylab_helpers import Gcf
from matplotlib.backend_bases import FigureManagerBase, _Backend
from matplotlib.backends.backend_agg import FigureCanvasAgg, _BackendAgg


class FigureManagerIDE(FigureManagerBase):
    def show(self):
        import ide

        ide.show_figure(self.canvas.figure)


class FigureCanvasIDE(FigureCanvasAgg):
    manager_class = FigureManagerIDE


@_Backend.export
class _BackendIDE(_BackendAgg):
    FigureCanvas = FigureCanvasIDE
    FigureManager = FigureManagerIDE

    @classmethod
    def show(cls, *args, block=None, **kwargs):
        import ide

        managers = Gcf.get_all_fig_managers()
        for manager in managers:
            ide.show_figure(manager.canvas.figure)
        Gcf.destroy_all()
