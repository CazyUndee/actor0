"""
Terminal-Bench adapter for actor0.

Terminal-Bench scores a task by starting a container, handing an agent an
instruction, letting it work, and then running the task's tests. Everything
in between — how the agent is installed, what environment it gets, and how
it is launched — is per-agent, and `opencode` is the only Node CLI in the
shipped set. So this follows it closely rather than inventing a shape.

Registered through `--agent-import-path`, which is the supported extension
point: no file in the installed package is patched, and the adapter lives in
this repository, versioned with the agent it measures.

Run it with:

    tb run create --agent-import-path tbench_actor0:Actor0Agent \\
        --model stealth/space-bunny-alpha -t <task-id>

with `PYTHONPATH` including this `bench/` directory, and the endpoint
credentials exported in the *host* shell — they are forwarded into the
container, never written into an image or a commit.
"""

import os
import shlex
import subprocess
import tempfile
from pathlib import Path

from terminal_bench.agents.installed_agents.abstract_installed_agent import (
    AbstractInstalledAgent,
)
from terminal_bench.terminal.models import TerminalCommand
from terminal_bench.utils.logger import logger
from terminal_bench.utils.template_utils import render_setup_script

# Where the CLI is built inside the container, and how it is invoked.
INSTALL_DIR = "/actor0"
CLI_ENTRY = f"{INSTALL_DIR}/apps/cli/dist/index.js"

# Host variables forwarded into the container. actor0 already reads all three,
# so this adapter decides nothing about how the endpoint is addressed — which
# is the property that lets the same build be measured against any provider.
FORWARDED = ("ACTOR0_API_KEY", "ACTOR0_BASE_URL", "ACTOR0_MODEL", "ACTOR0_PATH", "ACTOR0_SHELL")


class Actor0Agent(AbstractInstalledAgent):
    @staticmethod
    def name() -> str:
        return "actor0"

    def __init__(self, model_name: str = "stealth/space-bunny-alpha", *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._model_name = model_name
        self._logger = logger.getChild(__name__)

    @property
    def _env(self) -> dict[str, str]:
        """Host credentials, passed through untouched.

        Nothing is defaulted and nothing is derived. A benchmark that silently
        supplied its own endpoint would be measuring a different thing from the
        one it claims to, and the failure would look like a score rather than a
        setup mistake.
        """
        env = {key: os.environ[key] for key in FORWARDED if os.environ.get(key)}
        if "ACTOR0_MODEL" not in env:
            env["ACTOR0_MODEL"] = self._model_name
        if "ACTOR0_API_KEY" not in env and "ACTOR0_BASE_URL" not in env:
            raise ValueError(
                "actor0 needs an endpoint: export ACTOR0_BASE_URL and "
                "ACTOR0_API_KEY in the shell that runs `tb`, or the container "
                "will fall back to the built-in one and score something other "
                "than the model named on the command line."
            )
        return env

    def _get_template_variables(self) -> dict[str, str]:
        """Pin the exact commit the setup script builds.

        A benchmark whose agent moves underneath it is not reproducible, and
        `master` is a moving target. The ref can be overridden with
        `--agent-kwarg version=<sha>` when a result needs re-running.
        """
        return {"ref": self.version or self._default_ref(), "install_dir": INSTALL_DIR}

    @staticmethod
    def _default_ref() -> str:
        """The commit this working tree is on, read from the checkout itself.

        Failing soft to `master` rather than hard, because a hard failure here
        would stop the run before the container is even built, and an
        un-reproducible run is better than no run at all.
        """
        try:
            repo = Path(__file__).resolve().parent.parent
            return subprocess.run(
                ["git", "-C", str(repo), "rev-parse", "HEAD"],
                capture_output=True,
                text=True,
                timeout=30,
                check=True,
            ).stdout.strip()
        except Exception:  # noqa: BLE001 - any failure here must not stop a run
            return "master"

    @property
    def _install_agent_script_path(self) -> Path:
        return self._get_templated_script_path("actor0-setup.sh.j2")

    def _get_templated_script_path(self, template_name: str = "setup.sh.j2") -> Path:
        """Render the setup script, and write it with Unix line endings.

        The base class renders to a string and then hands it to
        `tempfile.NamedTemporaryFile(mode="w")`, which on a Windows host
        translates every `\\n` into `\\r\\n`. The container then fails on the
        third line with `set: pipefail: invalid option name`, and every line
        after it would have run as `apt-get update\\r` had the first one not
        already stopped the run.

        This is not a Windows quirk in the adapter's own file — it is in how
        the harness materialises every setup script, so it would break the
        shipped opencode adapter identically from this machine. The container
        sees a file the container cannot parse, and the harness has no way to
        tell that apart from an agent that failed the task, so the failure is
        scored as the second.

        The fix is to own the write and say `newline=""`. Jinja's output is
        already LF; the only translation happening is Python's.
        """
        template_path = Path(__file__).resolve().parent / template_name
        rendered = render_setup_script(template_path, self._get_template_variables())

        handle = tempfile.NamedTemporaryFile(
            mode="w", suffix=".sh", delete=False, newline="\n", encoding="utf-8"
        )
        try:
            handle.write(rendered)
        finally:
            handle.close()
        # The base class makes it executable; so does this, for the same
        # reason — a setup script that cannot be run is not a setup script.
        os.chmod(handle.name, 0o755)
        return Path(handle.name)

    def _run_agent_commands(self, instruction: str) -> list[TerminalCommand]:
        # `< /dev/null` because the headless path is a pipe, not a terminal:
        # with a TTY attached the CLI reads it for input and waits. `timeout`
        # is the harness's own, and unbounded here because actor0 terminates
        # itself on a completed answer, a stop, or its tool-round ceiling.
        command = (
            f"node {CLI_ENTRY} -p {shlex.quote(instruction)} "
            f"--cwd {shlex.quote(self._task_cwd())} < /dev/null"
        )
        return [
            TerminalCommand(
                command=command,
                min_timeout_sec=0.0,
                max_timeout_sec=float("inf"),
                block=True,
                append_enter=True,
            )
        ]

    @staticmethod
    def _task_cwd() -> str:
        """Where the task's work lives.

        `/app` is the convention across Terminal-Bench task images. It is
        passed explicitly rather than inherited, because the CLI's working
        directory decides which project instructions and which files the agent
        can see — and an agent launched one directory above the work solves a
        task nobody gave it.
        """
        return "/app"