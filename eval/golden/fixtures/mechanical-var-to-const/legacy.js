export function stats(xs) {
  var total = 0;
  var max = -Infinity;
  for (var i = 0; i < xs.length; i++) {
    total += xs[i];
    if (xs[i] > max) max = xs[i];
  }
  var mean = xs.length ? total / xs.length : 0;
  return { total: total, max: max, mean: mean };
}
