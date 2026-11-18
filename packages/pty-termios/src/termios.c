// Read the ECHO and ICANON bits of a terminal's termios flags (macOS and Linux only).
// Plain N-API with a fixed NAPI_VERSION, so one binary loads under both Node
// and Electron without a rebuild.
#define NAPI_VERSION 8
#include <node_api.h>

#include <errno.h>
#include <string.h>
#include <termios.h>

// Throw a JS error for a failed N-API call and return NULL from the caller.
#define CHECK(env, call)                                         \
  do {                                                           \
    if ((call) != napi_ok) {                                     \
      napi_throw_error((env), NULL, "N-API call failed: " #call); \
      return NULL;                                               \
    }                                                            \
  } while (0)

// localFlags(fd: number): { echo: boolean, icanon: boolean }
// The ECHO and ICANON bits of c_lflag for fd, from one tcgetattr call. Throw a
// TypeError on a bad argument and an Error with the strerror text when
// tcgetattr fails.
static napi_value LocalFlags(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  if (argc < 1) {
    napi_throw_type_error(env, NULL, "localFlags(fd): fd is required");
    return NULL;
  }
  napi_valuetype type;
  CHECK(env, napi_typeof(env, argv[0], &type));
  if (type != napi_number) {
    napi_throw_type_error(env, NULL, "localFlags(fd): fd must be a number");
    return NULL;
  }
  int32_t fd;
  CHECK(env, napi_get_value_int32(env, argv[0], &fd));

  struct termios t;
  if (tcgetattr(fd, &t) != 0) {
    napi_throw_error(env, NULL, strerror(errno));
    return NULL;
  }
  napi_value result;
  napi_value echo;
  napi_value icanon;
  CHECK(env, napi_create_object(env, &result));
  CHECK(env, napi_get_boolean(env, (t.c_lflag & ECHO) != 0, &echo));
  CHECK(env, napi_get_boolean(env, (t.c_lflag & ICANON) != 0, &icanon));
  CHECK(env, napi_set_named_property(env, result, "echo", echo));
  CHECK(env, napi_set_named_property(env, result, "icanon", icanon));
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  CHECK(env, napi_create_function(env, "localFlags", NAPI_AUTO_LENGTH, LocalFlags, NULL, &fn));
  CHECK(env, napi_set_named_property(env, exports, "localFlags", fn));
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
