#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#define CONTROL_FD 3
#define STATUS_FD 4
#define BUFFER_SIZE 65536

typedef struct { char bytes[BUFFER_SIZE]; size_t used; } Buffer;
typedef struct { pid_t pid, parent; unsigned long long start; bool owned; } Identity;
static volatile sig_atomic_t interrupted;
static pid_t shell_pid = -1;
static int shell_status;
static bool shell_exited;

static void on_signal(int number) { interrupted = number; }
static int64_t now_ms(void) {
  struct timespec value;
  clock_gettime(CLOCK_MONOTONIC, &value);
  return (int64_t)value.tv_sec * 1000 + value.tv_nsec / 1000000;
}
static void pause_ms(int ms) {
  struct timespec delay = { .tv_sec = ms / 1000, .tv_nsec = (ms % 1000) * 1000000L };
  nanosleep(&delay, NULL);
}
static void status_line(const char *value) {
  size_t length = strlen(value), offset = 0;
  while (offset < length) {
    ssize_t written = write(STATUS_FD, value + offset, length - offset);
    if (written > 0) offset += (size_t)written;
    else if (written < 0 && errno == EINTR) continue;
    else break;
  }
}
static void report_error(const char *message) {
  char escaped[2048], line[2160];
  size_t used = 0;
  for (const unsigned char *p = (const unsigned char *)message; *p && used + 7 < sizeof escaped; p++) {
    if (*p == '"' || *p == '\\') { escaped[used++] = '\\'; escaped[used++] = (char)*p; }
    else if (*p < 32) used += (size_t)snprintf(escaped + used, sizeof escaped - used, "\\u%04x", *p);
    else escaped[used++] = (char)*p;
  }
  escaped[used] = 0;
  snprintf(line, sizeof line, "{\"type\":\"error\",\"message\":\"%s\"}\n", escaped);
  status_line(line);
  fprintf(stderr, "%s\n", message);
}
static void report_errno(const char *stage, int number) {
  char message[1024];
  snprintf(message, sizeof message, "%s: %s", stage, strerror(number));
  report_error(message);
}
static int nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL);
  return flags < 0 ? -1 : fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}
static void reap_children(void) {
  int status;
  pid_t pid;
  while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
    if (pid == shell_pid) { shell_status = status; shell_exited = true; }
  }
}

// Read the start-time identity immediately before each signal so PID reuse
// cannot target a process which was never this helper's descendant.
static bool identity(pid_t pid, Identity *result) {
  char pathname[64], line[8192];
  snprintf(pathname, sizeof pathname, "/proc/%ld/stat", (long)pid);
  FILE *file = fopen(pathname, "r");
  if (!file) return false;
  char *read = fgets(line, sizeof line, file);
  fclose(file);
  if (!read) return false;
  char *tail = strrchr(line, ')');
  if (!tail || tail[1] != ' ') return false;
  char *cursor = NULL, *field = strtok_r(tail + 2, " ", &cursor);
  pid_t parent = -1;
  unsigned long long start = 0;
  for (int number = 3; field; number++, field = strtok_r(NULL, " ", &cursor)) {
    if (number == 4) parent = (pid_t)strtol(field, NULL, 10);
    if (number == 22) { start = strtoull(field, NULL, 10); break; }
  }
  if (parent < 0 || !start) return false;
  *result = (Identity){ .pid = pid, .parent = parent, .start = start };
  return true;
}
static int signal_descendants(int number) {
  DIR *directory = opendir("/proc");
  if (!directory) return -1;
  Identity *values = NULL;
  size_t count = 0, capacity = 0;
  struct dirent *entry;
  bool failed = false;
  while ((entry = readdir(directory))) {
    char *end;
    long candidate = strtol(entry->d_name, &end, 10);
    if (*end || candidate < 1 || candidate > INT_MAX) continue;
    Identity value;
    if (!identity((pid_t)candidate, &value)) continue;
    if (count == capacity) {
      size_t next = capacity ? capacity * 2 : 128;
      Identity *grown = realloc(values, next * sizeof *values);
      if (!grown) { failed = true; break; }
      values = grown; capacity = next;
    }
    values[count++] = value;
  }
  closedir(directory);
  if (failed) { free(values); return -1; }
  bool changed;
  do {
    changed = false;
    for (size_t i = 0; i < count; i++) {
      if (values[i].owned) continue;
      bool owned = values[i].parent == getpid();
      for (size_t j = 0; !owned && j < count; j++) {
        if (values[j].owned && values[i].parent == values[j].pid) owned = true;
      }
      if (owned) { values[i].owned = true; changed = true; }
    }
  } while (changed);
  int remaining = 0;
  for (size_t i = count; i > 0; i--) {
    Identity *value = &values[i - 1], current;
    if (!value->owned || !identity(value->pid, &current) || current.start != value->start) continue;
    remaining++;
    if (number) kill(value->pid, number);
  }
  free(values);
  return remaining;
}
static bool cleanup(void) {
  int64_t started = now_ms(), deadline = started + 2200;
  do {
    reap_children();
    int remaining = signal_descendants(now_ms() - started < 700 ? SIGTERM : SIGKILL);
    reap_children();
    if (remaining == 0) return true;
    if (remaining < 0) {
      report_error("Cannot inspect terminal descendants during shutdown");
      // The immediate child is still ours even if /proc became unavailable.
      if (!shell_exited && shell_pid > 0) kill(shell_pid, SIGKILL);
    }
    pause_ms(25);
  } while (now_ms() < deadline);
  reap_children();
  return signal_descendants(0) == 0;
}
static const char *signal_name(int number) {
  switch (number) {
    case SIGHUP: return "SIGHUP";
    case SIGINT: return "SIGINT";
    case SIGQUIT: return "SIGQUIT";
    case SIGILL: return "SIGILL";
    case SIGABRT: return "SIGABRT";
    case SIGFPE: return "SIGFPE";
    case SIGKILL: return "SIGKILL";
    case SIGSEGV: return "SIGSEGV";
    case SIGPIPE: return "SIGPIPE";
    case SIGALRM: return "SIGALRM";
    case SIGTERM: return "SIGTERM";
    default: return "UNKNOWN";
  }
}
static void report_exit(void) {
  char line[160];
  if (shell_exited && WIFEXITED(shell_status))
    snprintf(line, sizeof line, "{\"type\":\"exit\",\"code\":%d,\"signal\":null}\n", WEXITSTATUS(shell_status));
  else if (shell_exited && WIFSIGNALED(shell_status))
    snprintf(line, sizeof line, "{\"type\":\"exit\",\"code\":null,\"signal\":\"%s\"}\n", signal_name(WTERMSIG(shell_status)));
  else snprintf(line, sizeof line, "{\"type\":\"exit\",\"code\":null,\"signal\":null}\n");
  status_line(line);
}
static bool dimension(const char *text, unsigned short *result, int minimum) {
  char *end;
  errno = 0;
  long value = strtol(text, &end, 10);
  if (errno || !*text || *end || value < minimum || value > 1000) return false;
  *result = (unsigned short)value;
  return true;
}
static bool consume_control(char *line, int master) {
  if (!strcmp(line, "close")) return false;
  char cols[32], rows[32], extra;
  struct winsize size = {0};
  if (sscanf(line, "resize %31s %31s %c", cols, rows, &extra) != 2 ||
      !dimension(cols, &size.ws_col, 2) || !dimension(rows, &size.ws_row, 1)) {
    report_error("Invalid terminal control command");
    return false;
  }
  if (ioctl(master, TIOCSWINSZ, &size) < 0) { report_errno("Resize terminal", errno); return false; }
  return true;
}
static int read_buffer(int fd, Buffer *buffer) {
  ssize_t bytes = read(fd, buffer->bytes + buffer->used, sizeof buffer->bytes - buffer->used);
  if (bytes > 0) { buffer->used += (size_t)bytes; return 1; }
  if (bytes < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) return 1;
  return 0;
}
static bool write_buffer(int fd, Buffer *buffer) {
  ssize_t bytes = write(fd, buffer->bytes, buffer->used);
  if (bytes > 0) {
    buffer->used -= (size_t)bytes;
    memmove(buffer->bytes, buffer->bytes + bytes, buffer->used);
    return true;
  }
  return bytes < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR);
}
static void flush_output(Buffer *buffer) {
  int64_t deadline = now_ms() + 400;
  while (buffer->used && now_ms() < deadline) {
    struct pollfd fd = { .fd = STDOUT_FILENO, .events = POLLOUT };
    if (poll(&fd, 1, 25) > 0 && !write_buffer(STDOUT_FILENO, buffer)) break;
  }
}
static void child_error(int fd, int number) {
  ssize_t ignored = write(fd, &number, sizeof number);
  (void)ignored;
  _exit(127);
}
static void close_child_channels(int error_fd) {
  DIR *directory = opendir("/proc/self/fd");
  if (!directory) child_error(error_fd, errno);
  int directory_fd = dirfd(directory);
  struct dirent *entry;
  while ((entry = readdir(directory))) {
    char *end;
    long fd = strtol(entry->d_name, &end, 10);
    if (!*end && fd > 2 && fd <= INT_MAX && fd != error_fd && fd != directory_fd) close((int)fd);
  }
  closedir(directory);
}

int main(int argc, char **argv) {
  struct winsize size = {0};
  if (argc != 4 || !dimension(argv[2], &size.ws_col, 2) || !dimension(argv[3], &size.ws_row, 1)) {
    report_error("Usage: terminal-helper SHELL COLS ROWS"); return 1;
  }
  pid_t owner = getppid();
  struct sigaction action = { .sa_handler = on_signal };
  sigemptyset(&action.sa_mask);
  for (size_t i = 0; i < 3; i++) sigaction((int[]){SIGTERM, SIGINT, SIGHUP}[i], &action, NULL);
  signal(SIGPIPE, SIG_IGN);
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) < 0) { report_errno("Enable terminal child adoption", errno); return 1; }
  if (prctl(PR_SET_PDEATHSIG, SIGTERM) < 0) { report_errno("Watch terminal owner", errno); return 1; }
  Identity self;
  if (!identity(getpid(), &self)) { report_error("Cannot inspect terminal process identity"); return 1; }
  if (getppid() != owner || interrupted) return 1;
  int master = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
  if (master < 0) { report_errno("Open terminal PTY", errno); return 1; }
  char slave[PATH_MAX];
  char *name = NULL;
  if (grantpt(master) < 0 || unlockpt(master) < 0 || !(name = ptsname(master)) ||
      strlen(name) >= sizeof slave || ioctl(master, TIOCSWINSZ, &size) < 0) {
    report_errno("Initialize terminal PTY", errno); close(master); return 1;
  }
  strcpy(slave, name);
  int errors[2];
  if (pipe2(errors, O_CLOEXEC) < 0) { report_errno("Open shell startup channel", errno); close(master); return 1; }
  shell_pid = fork();
  if (shell_pid < 0) { report_errno("Fork terminal shell", errno); close(master); close(errors[0]); close(errors[1]); return 1; }
  if (shell_pid == 0) {
    close(errors[0]);
    signal(SIGPIPE, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGTERM, SIG_DFL); signal(SIGHUP, SIG_DFL);
    if (setsid() < 0) child_error(errors[1], errno);
    int tty = open(slave, O_RDWR);
    if (tty < 0 || ioctl(tty, TIOCSCTTY, 0) < 0) child_error(errors[1], errno);
    for (int fd = 0; fd < 3; fd++) if (dup2(tty, fd) < 0) child_error(errors[1], errno);
    // Only the exec-error writer survives until exec. No shell descendant may
    // keep the Web owner's control/status pipes alive.
    close_child_channels(errors[1]);
    if (setenv("TERM", "xterm-256color", 1) < 0) child_error(errors[1], errno);
    execlp(argv[1], argv[1], "-i", (char *)NULL);
    child_error(errors[1], errno);
  }
  close(errors[1]);
  struct pollfd startup = { .fd = errors[0], .events = POLLIN };
  int polled;
  do { polled = poll(&startup, 1, 5000); } while (polled < 0 && errno == EINTR && !interrupted);
  int exec_error = 0;
  ssize_t error_bytes = polled > 0 ? read(errors[0], &exec_error, sizeof exec_error) : -1;
  close(errors[0]);
  if (error_bytes != 0 || interrupted || getppid() != owner) {
    if (error_bytes > 0) report_errno("Execute terminal shell", exec_error);
    else if (!interrupted) report_error("Terminal shell startup did not complete");
    close(master); bool cleaned = cleanup(); report_exit(); return cleaned ? 1 : 2;
  }
  if (nonblocking(master) < 0 || nonblocking(STDIN_FILENO) < 0 ||
      nonblocking(STDOUT_FILENO) < 0 || nonblocking(CONTROL_FD) < 0) {
    report_errno("Configure terminal channels", errno);
    close(master); cleanup(); report_exit(); return 1;
  }
  char ready[100];
  snprintf(ready, sizeof ready, "{\"type\":\"ready\",\"pid\":%ld}\n", (long)shell_pid);
  status_line(ready);
  Buffer input = {0}, output = {0};
  char command[256]; size_t command_length = 0;
  bool running = true;
  while (running && !interrupted && getppid() == owner) {
    reap_children();
    if (shell_exited) {
      // Preserve the shell's final output before closing the PTY master.
      while (output.used < sizeof output.bytes) {
        size_t previous = output.used;
        if (!read_buffer(master, &output) || output.used == previous) break;
      }
      break;
    }
    struct pollfd fds[] = {
      { .fd = STDIN_FILENO, .events = input.used < sizeof input.bytes ? POLLIN : 0 },
      { .fd = master, .events = (output.used < sizeof output.bytes ? POLLIN : 0) | (input.used ? POLLOUT : 0) },
      { .fd = STDOUT_FILENO, .events = output.used ? POLLOUT : 0 },
      { .fd = CONTROL_FD, .events = POLLIN },
    };
    int result = poll(fds, 4, 100);
    if (result < 0) { if (errno == EINTR) continue; report_errno("Poll terminal channels", errno); break; }
    if (fds[0].revents & (POLLHUP | POLLERR | POLLNVAL)) running = false;
    if (running && (fds[0].revents & POLLIN) && !read_buffer(STDIN_FILENO, &input)) running = false;
    if (fds[1].revents & POLLIN) {
      if (!read_buffer(master, &output)) running = false;
    } else if (fds[1].revents & (POLLHUP | POLLERR | POLLNVAL)) running = false;
    if (input.used && (fds[1].revents & POLLOUT) && !write_buffer(master, &input)) running = false;
    if (output.used && (fds[2].revents & POLLOUT) && !write_buffer(STDOUT_FILENO, &output)) running = false;
    if (fds[2].revents & (POLLHUP | POLLERR | POLLNVAL)) running = false;
    if (fds[3].revents & (POLLHUP | POLLERR | POLLNVAL)) running = false;
    if (running && (fds[3].revents & POLLIN)) {
      char bytes[256]; ssize_t count = read(CONTROL_FD, bytes, sizeof bytes);
      if (count == 0 || (count < 0 && errno != EAGAIN && errno != EINTR)) running = false;
      for (ssize_t i = 0; running && i < count; i++) {
        if (bytes[i] == '\n') { command[command_length] = 0; running = consume_control(command, master); command_length = 0; }
        else if (command_length + 1 < sizeof command) command[command_length++] = bytes[i];
        else { report_error("Terminal control command too long"); running = false; }
      }
    }
  }
  close(master);
  bool cleaned = cleanup();
  flush_output(&output);
  if (!cleaned) report_error("Terminal shutdown left running descendants");
  report_exit();
  return cleaned ? 0 : 2;
}
