const sq1 = "Иван Иванов";
const sq2 = "+37377123456";
const sq3 = "8(777)12345";
const sq4 = "000081123456";

function buildOr(searchQuery) {
  const sq = searchQuery.replace(/"/g, ''); 
  return `name.ilike."%${sq}%",phone.ilike."%${sq}%",receipt.ilike."%${sq}%"`;
}

console.log(buildOr(sq1));
console.log(buildOr(sq2));
console.log(buildOr(sq3));
console.log(buildOr(sq4));
