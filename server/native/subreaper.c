#include <node_api.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <errno.h>

// Keep detached grandchildren attached to the Node guardian when their
// immediate parent exits. No root privilege or extra daemon is needed.
static napi_value enable(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_get_boolean(env, prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) == 0, &result);
  return result;
}

// libuv owns the app-server ChildProcess. Reap only other, adopted zombies
// selected by the guardian; never consume libuv's immediate-child exit status.
static napi_value reap(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value argument, result;
  uint32_t pid;
  if (napi_get_cb_info(env, info, &count, &argument, NULL, NULL) != napi_ok || count != 1 ||
      napi_get_value_uint32(env, argument, &pid) != napi_ok || pid < 2) {
    napi_throw_type_error(env, NULL, "Expected an adopted child PID");
    return NULL;
  }
  int status;
  int waited = waitpid((pid_t)pid, &status, WNOHANG);
  napi_get_boolean(env, waited == (int)pid || (waited < 0 && errno == ECHILD), &result);
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "enable", NAPI_AUTO_LENGTH, enable, NULL, &function);
  napi_set_named_property(env, exports, "enable", function);
  napi_create_function(env, "reap", NAPI_AUTO_LENGTH, reap, NULL, &function);
  napi_set_named_property(env, exports, "reap", function);
  return exports;
}

NAPI_MODULE(subreaper, initialize)
