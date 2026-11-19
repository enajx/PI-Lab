// Read the ECHO and ICANON bits of a terminal's termios flags, and turn on
// IUTF8 (macOS and Linux only).
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

// Read the one fd argument into *fd. Throw a TypeError with the `missing` or
// `notNumber` text and return 0 when it is missing or not a number.
static int FdArgument(napi_env env, napi_callback_info info, const char* missing,
                      const char* notNumber, int32_t* fd) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) {
    napi_throw_error(env, NULL, "N-API call failed: napi_get_cb_info");
    return 0;
  }
  if (argc < 1) {
    napi_throw_type_error(env, NULL, missing);
    return 0;
  }
  napi_valuetype type;
  if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_number) {
    napi_throw_type_error(env, NULL, notNumber);
    return 0;
  }
  if (napi_get_value_int32(env, argv[0], fd) != napi_ok) {
    napi_throw_error(env, NULL, "N-API call failed: napi_get_value_int32");
    return 0;
  }
  return 1;
}

// A string with the strerror text of errno.
static napi_value ErrnoText(napi_env env) {
  napi_value text;
  CHECK(env, napi_create_string_utf8(env, strerror(errno), NAPI_AUTO_LENGTH, &text));
  return text;
}

// localFlags(fd: number): { echo: boolean, icanon: boolean } | { error: string }
// The ECHO and ICANON bits of c_lflag for fd, from one tcgetattr call. Throw a
// TypeError on a bad argument; return { error } with the strerror text when
// tcgetattr fails.
static napi_value LocalFlags(napi_env env, napi_callback_info info) {
  int32_t fd;
  if (!FdArgument(env, info, "localFlags(fd): fd is required",
                  "localFlags(fd): fd must be a number", &fd)) {
    return NULL;
  }

  struct termios t;
  napi_value result;
  if (tcgetattr(fd, &t) != 0) {
    napi_value text = ErrnoText(env);
    if (text == NULL) return NULL;
    CHECK(env, napi_create_object(env, &result));
    CHECK(env, napi_set_named_property(env, result, "error", text));
    return result;
  }
  napi_value echo;
  napi_value icanon;
  CHECK(env, napi_create_object(env, &result));
  CHECK(env, napi_get_boolean(env, (t.c_lflag & ECHO) != 0, &echo));
  CHECK(env, napi_get_boolean(env, (t.c_lflag & ICANON) != 0, &icanon));
  CHECK(env, napi_set_named_property(env, result, "echo", echo));
  CHECK(env, napi_set_named_property(env, result, "icanon", icanon));
  return result;
}

// setUtf8(fd: number): string | null
// Turn on IUTF8 in c_iflag for fd (tcgetattr, then tcsetattr TCSANOW). Throw a
// TypeError on a bad argument; return the strerror text when a call fails,
// null on success.
static napi_value SetUtf8(napi_env env, napi_callback_info info) {
  int32_t fd;
  if (!FdArgument(env, info, "setUtf8(fd): fd is required", "setUtf8(fd): fd must be a number",
                  &fd)) {
    return NULL;
  }
  struct termios t;
  if (tcgetattr(fd, &t) != 0) return ErrnoText(env);
  t.c_iflag |= IUTF8;
  if (tcsetattr(fd, TCSANOW, &t) != 0) return ErrnoText(env);
  napi_value result;
  CHECK(env, napi_get_null(env, &result));
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  CHECK(env, napi_create_function(env, "localFlags", NAPI_AUTO_LENGTH, LocalFlags, NULL, &fn));
  CHECK(env, napi_set_named_property(env, exports, "localFlags", fn));
  CHECK(env, napi_create_function(env, "setUtf8", NAPI_AUTO_LENGTH, SetUtf8, NULL, &fn));
  CHECK(env, napi_set_named_property(env, exports, "setUtf8", fn));
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
