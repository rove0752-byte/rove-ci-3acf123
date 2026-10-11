#include <resolv.h>
#include <stdio.h>
int main(void) {
  if (res_init() != 0) return 2;
  printf("resolver initialization passed: search=%s\n", _res.defdname);
  return 0;
}
