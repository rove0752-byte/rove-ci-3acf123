// CVE-2026-95619: exercise the image's dynamically linked aligned operator new.
// Compile separately; no compiler, test binary or added library ships in Rove.
#include <new>
#include <initializer_list>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <limits>
using Alloc = void* (*)(std::size_t, std::align_val_t);
int main() {
  auto fn = reinterpret_cast<Alloc>(dlsym(RTLD_DEFAULT, "_ZnwmSt11align_val_t"));
  if (!fn) return 2;
  Dl_info info{}; if (!dladdr(reinterpret_cast<void*>(fn), &info)) return 3;
  std::printf("library=%s symbol=%s\n", info.dli_fname, info.dli_sname);
  auto limit = std::numeric_limits<std::size_t>::max();
  // Positive control: reproduce the vulnerable arithmetic without corrupting memory.
  volatile std::size_t huge = limit;
  const auto rounded = (huge + 63) & ~std::size_t(63);
  void* bad = std::aligned_alloc(64, rounded);
  if (rounded != 0 || !bad) return 4;
  std::free(bad); std::puts("vulnerable-rounding control detected undersized allocation");
  std::size_t sizes[] = {limit, limit-1, limit-15, limit-63, limit-4095};
  std::size_t aligns[] = {16,64,4096,std::size_t(1) << 63};
  unsigned rejected=0;
  for (auto alignment : aligns) for (auto size : sizes) {
    try {
      void* p = fn(size, std::align_val_t(alignment));
      if (p) ::operator delete(p, std::align_val_t(alignment));
      std::fprintf(stderr,"FAIL size=%zu alignment=%zu returned instead of throwing\n",size,alignment);
      return 5;
    } catch (const std::bad_alloc&) {++rejected;}
  }
  for (auto alignment : {std::size_t(16),std::size_t(64),std::size_t(4096)}) {
    void* p=fn(128,std::align_val_t(alignment));
    if (!p || reinterpret_cast<std::uintptr_t>(p)%alignment) return 6;
    std::memset(p,0x5a,128);::operator delete(p,std::align_val_t(alignment));
  }
  std::printf("Aligned allocation verification passed: %u overflow cases rejected; 3 valid allocations\n",rejected);
}
